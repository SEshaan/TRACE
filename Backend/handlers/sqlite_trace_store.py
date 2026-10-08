from __future__ import annotations

import json
import sqlite3
import uuid
from pathlib import Path
from typing import Any, Sequence

from handlers.actions import (
    AbortQueryAction,
    AggregateAction,
    FilterAction,
    FinishAction,
    GroupByAction,
    InsufficientInfoAction,
    JoinAction,
    LimitAction,
    OrderByAction,
    SchemaMissingAction,
    SelectColumnAction,
    SelectTableAction,
)
from handlers.query_handler import (
    ActionFailure,
    Checkpoint,
    PreviewResult,
    QueryAction,
    QuerySession,
    QueryState,
    QueryStatus,
    QueryTrace,
    TraceStore,
)


class SQLiteTraceStore(TraceStore):
    """
    Relational SQLite persistence for query execution traces, checkpoints,
    failures, audit logs, and learning outcomes.
    """

    def __init__(self, db_path: str):
        self.db_path = db_path
        self._init_db()

    def _get_connection(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON;")
        return conn

    def _init_db(self) -> None:
        schema_path = Path(__file__).resolve().parent.parent / "db_adapters" / "trace_schema.sql"
        with open(schema_path, "r", encoding="utf-8") as f:
            sql_script = f.read()
        with self._get_connection() as conn:
            conn.executescript(sql_script)

    # ------------------------------------------------------------------
    # Sessions
    # ------------------------------------------------------------------

    def create_session(
        self,
        *,
        request: str,
        root_state: QueryState,
        model_version: str | None = None,
    ) -> QuerySession:
        session_id = str(uuid.uuid4())
        session = QuerySession(
            id=session_id,
            request=request,
            root_state_id=root_state.id,
            current_state_id=root_state.id,
            status=QueryStatus.NEW,
            model_version=model_version,
        )

        with self._get_connection() as conn:
            # Register model version if provided
            if model_version:
                conn.execute(
                    """
                    INSERT OR IGNORE INTO model_versions (id, model_name, provider)
                    VALUES (?, ?, ?)
                    """,
                    (model_version, model_version, "unknown"),
                )

            conn.execute(
                """
                INSERT INTO query_sessions (id, request, root_state_id, current_state_id, status, model_version_id)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (session_id, request, root_state.id, root_state.id, QueryStatus.NEW.value, model_version),
            )
            # Log training sample starter
            conn.execute(
                """
                INSERT INTO training_samples (id, session_id, natural_language_request, state_context_json, target_action_json)
                VALUES (?, ?, ?, ?, ?)
                """,
                (str(uuid.uuid4()), session_id, request, "{}", "{}"),
            )
            row = conn.execute(
                "SELECT created_at, updated_at FROM query_sessions WHERE id = ?",
                (session_id,),
            ).fetchone()
            created_at = row["created_at"] if row else None
            updated_at = row["updated_at"] if row else None

        return QuerySession(
            id=session_id,
            request=request,
            root_state_id=root_state.id,
            current_state_id=root_state.id,
            status=QueryStatus.NEW,
            model_version=model_version,
            created_at=created_at,
            updated_at=updated_at,
        )

    def get_session(self, session_id: str) -> QuerySession:
        with self._get_connection() as conn:
            row = conn.execute(
                "SELECT * FROM query_sessions WHERE id = ?",
                (session_id,),
            ).fetchone()
            if not row:
                raise KeyError(f"Session '{session_id}' not found.")
            return QuerySession(
                id=row["id"],
                request=row["request"],
                root_state_id=row["root_state_id"],
                current_state_id=row["current_state_id"],
                status=QueryStatus(row["status"]),
                model_version=row["model_version_id"],
                created_at=row["created_at"] if "created_at" in row.keys() else None,
                updated_at=row["updated_at"] if "updated_at" in row.keys() else None,
            )

    def update_session(
        self,
        session_id: str,
        *,
        current_state_id: str,
        status: QueryStatus,
        request: str | None = None,
    ) -> None:
        with self._get_connection() as conn:
            conn.execute(
                """
                UPDATE query_sessions
                SET current_state_id = ?, status = ?,
                    request = COALESCE(?, request),
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (current_state_id, status.value, request, session_id),
            )

    def list_sessions(
        self,
        *,
        status: str | None = None,
        q: str | None = None,
        limit: int = 50,
    ) -> list[dict[str, Any]]:
        query = """
            SELECT 
                s.id,
                s.request,
                s.status,
                s.model_version_id,
                s.created_at,
                s.updated_at,
                (SELECT COUNT(*) FROM query_states qs WHERE qs.session_id = s.id) AS state_count,
                (SELECT COUNT(*) FROM failure_logs fl WHERE fl.session_id = s.id) AS failure_count
            FROM query_sessions s
            WHERE 1=1
        """
        params: list[Any] = []
        if status:
            query += " AND s.status = ?"
            params.append(status)
        if q:
            query += " AND s.request LIKE ?"
            params.append(f"%{q}%")
        query += " ORDER BY s.created_at DESC LIMIT ?"
        params.append(limit)

        with self._get_connection() as conn:
            rows = conn.execute(query, tuple(params)).fetchall()
            return [
                {
                    "id": r["id"],
                    "request": r["request"],
                    "status": r["status"],
                    "model_version": r["model_version_id"],
                    "created_at": r["created_at"],
                    "updated_at": r["updated_at"],
                    "state_count": r["state_count"],
                    "has_failure": r["failure_count"] > 0,
                }
                for r in rows
            ]

    # ------------------------------------------------------------------
    # States
    # ------------------------------------------------------------------

    def save_state(self, session_id: str, state: QueryState) -> None:
        preview_data = None
        if state.preview is not None:
            preview_data = json.dumps({
                "columns": list(state.preview.columns),
                "rows": list(state.preview.rows),
                "row_count": state.preview.row_count,
                "truncated": state.preview.truncated,
                "execution_time_ms": state.preview.execution_time_ms,
            })

        with self._get_connection() as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO query_states (id, session_id, parent_id, status, sql_text, preview_json)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (state.id, session_id, state.parent_id, state.status.value, state.sql, preview_data),
            )

            # Insert state actions
            for idx, action in enumerate(state.actions):
                action_id = f"{state.id}_act_{idx}"
                atype = getattr(action, "action_type", "UNKNOWN")
                params = getattr(action, "to_dict", lambda: vars(action))()
                conf = getattr(action, "confidence", 1.0)
                conn.execute(
                    """
                    INSERT OR REPLACE INTO query_actions (id, state_id, action_type, parameters_json, confidence, sequence_order)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (action_id, state.id, atype, json.dumps(params), conf, idx),
                )

            # Insert exploration node for React Flow graph
            node_type = "action" if state.parent_id else "root"
            conn.execute(
                """
                INSERT OR REPLACE INTO exploration_nodes (id, session_id, state_id, node_type, ui_metadata_json)
                VALUES (?, ?, ?, ?, ?)
                """,
                (f"node_{state.id}", session_id, state.id, node_type, json.dumps({"action_count": len(state.actions)})),
            )

            # Log audit execution log if preview executed
            if state.preview:
                conn.execute(
                    """
                    INSERT INTO execution_logs (id, session_id, state_id, sql_executed, duration_ms, row_count)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (str(uuid.uuid4()), session_id, state.id, state.sql, state.preview.execution_time_ms, state.preview.row_count),
                )

    def get_state(self, state_id: str) -> QueryState:
        with self._get_connection() as conn:
            row = conn.execute(
                "SELECT * FROM query_states WHERE id = ?",
                (state_id,),
            ).fetchone()
            if not row:
                raise KeyError(f"State '{state_id}' not found.")

            # Load actions
            act_rows = conn.execute(
                "SELECT * FROM query_actions WHERE state_id = ? ORDER BY sequence_order ASC",
                (state_id,),
            ).fetchall()
            actions: list[QueryAction] = []
            for a_row in act_rows:
                actions.append(self._deserialize_action(a_row["action_type"], json.loads(a_row["parameters_json"])))

            # Load preview
            preview = None
            if row["preview_json"]:
                p_data = json.loads(row["preview_json"])
                preview = PreviewResult(
                    columns=tuple(p_data["columns"]),
                    rows=tuple(p_data["rows"]),
                    row_count=p_data["row_count"],
                    truncated=p_data["truncated"],
                    execution_time_ms=p_data["execution_time_ms"],
                )

            return QueryState(
                id=row["id"],
                parent_id=row["parent_id"],
                actions=tuple(actions),
                status=QueryStatus(row["status"]),
                sql=row["sql_text"],
                preview=preview,
            )

    # ------------------------------------------------------------------
    # Failures
    # ------------------------------------------------------------------

    def save_failure(
        self,
        *,
        session_id: str,
        state_id: str,
        action: QueryAction,
        failure: ActionFailure,
    ) -> None:
        with self._get_connection() as conn:
            conn.execute(
                """
                INSERT INTO failure_logs (id, session_id, state_id, action_type, error_code, error_message)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (str(uuid.uuid4()), session_id, state_id, failure.action_type, failure.code, failure.message),
            )
            # Record negative training outcome for model learning
            conn.execute(
                """
                INSERT INTO training_samples (id, session_id, natural_language_request, state_context_json, target_action_json, is_positive_sample)
                VALUES (?, ?, ?, ?, ?, 0)
                """,
                (str(uuid.uuid4()), session_id, "failure_feedback", json.dumps({"state_id": state_id}), json.dumps({"action": failure.action_type, "error": failure.message})),
            )

    # ------------------------------------------------------------------
    # Checkpoints
    # ------------------------------------------------------------------

    def save_checkpoint(
        self,
        *,
        session_id: str,
        checkpoint: Checkpoint,
    ) -> None:
        with self._get_connection() as conn:
            conn.execute(
                """
                INSERT INTO checkpoints (id, session_id, state_id, label)
                VALUES (?, ?, ?, ?)
                """,
                (checkpoint.id, session_id, checkpoint.state_id, checkpoint.label),
            )
            conn.execute(
                """
                INSERT OR REPLACE INTO exploration_nodes (id, session_id, state_id, node_type, ui_metadata_json)
                VALUES (?, ?, ?, ?, ?)
                """,
                (f"cp_{checkpoint.id}", session_id, checkpoint.state_id, "checkpoint", json.dumps({"label": checkpoint.label})),
            )

    def get_checkpoint(self, checkpoint_id: str) -> Checkpoint:
        with self._get_connection() as conn:
            row = conn.execute(
                "SELECT * FROM checkpoints WHERE id = ?",
                (checkpoint_id,),
            ).fetchone()
            if not row:
                raise KeyError(f"Checkpoint '{checkpoint_id}' not found.")
            return Checkpoint(
                id=row["id"],
                state_id=row["state_id"],
                label=row["label"],
            )

    # ------------------------------------------------------------------
    # Trace Graph
    # ------------------------------------------------------------------

    def get_trace(self, session_id: str) -> QueryTrace:
        session = self.get_session(session_id)
        with self._get_connection() as conn:
            # States
            state_rows = conn.execute(
                "SELECT id FROM query_states WHERE session_id = ? ORDER BY created_at ASC",
                (session_id,),
            ).fetchall()
            states = [self.get_state(r["id"]) for r in state_rows]

            # Checkpoints
            cp_rows = conn.execute(
                "SELECT * FROM checkpoints WHERE session_id = ? ORDER BY created_at ASC",
                (session_id,),
            ).fetchall()
            checkpoints = [
                Checkpoint(id=r["id"], state_id=r["state_id"], label=r["label"])
                for r in cp_rows
            ]

            # Failures
            fail_rows = conn.execute(
                "SELECT * FROM failure_logs WHERE session_id = ? ORDER BY created_at ASC",
                (session_id,),
            ).fetchall()
            failures = [
                ActionFailure(
                    action_type=r["action_type"],
                    code=r["error_code"],
                    message=r["error_message"],
                    state_id=r["state_id"],
                )
                for r in fail_rows
            ]

            return QueryTrace(
                session=session,
                states=tuple(states),
                checkpoints=tuple(checkpoints),
                failures=tuple(failures),
            )

    # ------------------------------------------------------------------
    # Metadata persistence helper
    # ------------------------------------------------------------------

    def sync_database_metadata(self, database_name: str, schema: Any, connection_uri: str = "") -> str:
        db_id = str(uuid.uuid5(uuid.NAMESPACE_DNS, database_name))
        schema_id = str(uuid.uuid5(uuid.NAMESPACE_DNS, f"{database_name}_schema"))
        with self._get_connection() as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO databases (id, name, engine, connection_uri)
                VALUES (?, ?, ?, ?)
                """,
                (db_id, database_name, "sqlite", connection_uri),
            )
            conn.execute(
                """
                INSERT OR REPLACE INTO schemas (id, database_id, name)
                VALUES (?, ?, ?)
                """,
                (schema_id, db_id, "main"),
            )
            if schema and hasattr(schema, "tables"):
                for table in schema.tables:
                    table_id = str(uuid.uuid5(uuid.NAMESPACE_DNS, f"{schema_id}_{table.name}"))
                    conn.execute(
                        """
                        INSERT OR REPLACE INTO tables (id, schema_id, name)
                        VALUES (?, ?, ?)
                        """,
                        (table_id, schema_id, table.name),
                    )
                    for col in getattr(table, "columns", []):
                        col_id = str(uuid.uuid5(uuid.NAMESPACE_DNS, f"{table_id}_{col.name}"))
                        conn.execute(
                            """
                            INSERT OR REPLACE INTO columns (id, table_id, name, data_type, nullable, primary_key)
                            VALUES (?, ?, ?, ?, ?, ?)
                            """,
                            (col_id, table_id, col.name, col.data_type, col.nullable, col.primary_key),
                        )
        return db_id

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _deserialize_action(action_type: str, params: dict[str, Any]) -> QueryAction:
        atype = action_type.upper()
        conf = float(params.get("confidence", 1.0))
        if atype == "SELECT_TABLE":
            return SelectTableAction(table=params["table"], confidence=conf)
        elif atype == "SELECT_COLUMN":
            return SelectColumnAction(column=params["column"], table=params.get("table"), alias=params.get("alias"), confidence=conf)
        elif atype == "FILTER":
            return FilterAction(column=params["column"], operator=params["operator"], value=params["value"], table=params.get("table"), confidence=conf)
        elif atype == "JOIN":
            return JoinAction(table=params["table"], left_on=params["left_on"], right_on=params["right_on"], join_type=params.get("join_type", "INNER"), confidence=conf)
        elif atype == "GROUP_BY":
            return GroupByAction(column=params["column"], table=params.get("table"), confidence=conf)
        elif atype == "AGGREGATE":
            return AggregateAction(
                function=params["function"],
                column=params["column"],
                table=params.get("table"),
                alias=params.get("alias"),
                confidence=conf,
            )
        elif atype == "ORDER_BY":
            return OrderByAction(
                column=params["column"],
                direction=params.get("direction", "ASC"),
                table=params.get("table"),
                aggregate_function=params.get("aggregate_function"),
                confidence=conf,
            )
        elif atype == "LIMIT":
            return LimitAction(limit=int(params["limit"]), confidence=conf)
        elif atype == "FINISH":
            return FinishAction(confidence=conf)
        elif atype == "INSUFFICIENT_INFO":
            return InsufficientInfoAction(
                reason=params.get("reason", ""),
                clarification=params.get("clarification", ""),
                missing_fields=params.get("missing_fields"),
                confidence=conf,
            )
        elif atype == "SCHEMA_MISSING":
            return SchemaMissingAction(
                reason=params.get("reason", ""),
                table=params.get("table"),
                column=params.get("column"),
                expected_relationship=params.get("expected_relationship"),
                confidence=conf,
            )
        elif atype == "ABORT_QUERY":
            return AbortQueryAction(reason=params.get("reason", ""), confidence=conf)
        raise ValueError(f"Unknown action type: {action_type}")
