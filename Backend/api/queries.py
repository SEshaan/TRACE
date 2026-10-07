from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from handlers.query_handler import (
    ActionResult,
    Checkpoint,
    QueryAction,
    QueryHandler,
    QueryResult,
    QuerySession,
    QueryState,
    QueryStatus,
    QueryTrace,
)
from pydantic import BaseModel, Field

router = APIRouter(
    prefix="/queries",
    tags=["queries"],
)


# ============================================================================
# Dependencies
# ============================================================================


_global_handler: QueryHandler | None = None
_global_agent_controller: Any | None = None


def set_query_handler(handler: QueryHandler) -> None:
    global _global_handler
    _global_handler = handler


def get_agent_controller():
    global _global_agent_controller
    if _global_agent_controller is None:
        from handlers.agent_controller import create_agent_controller
        _global_agent_controller = create_agent_controller()
    return _global_agent_controller


def get_query_handler() -> QueryHandler:
    """
    Application dependency for QueryHandler.
    """
    global _global_handler
    if _global_handler is not None:
        return _global_handler

    import os

    from db_adapters.sqlite_adapter import SQLiteAdapter
    from handlers.compiler import SQLiteCompiler
    from handlers.db_adapter import SQLiteDatabaseAdapter
    from handlers.schema_provider import SQLiteSchemaProvider
    from handlers.sqlite_trace_store import SQLiteTraceStore
    from handlers.state_engine import DefaultQueryStateEngine
    from handlers.validator import DeterministicValidator

    db_path = os.environ.get(
        "DATABASE_PATH",
        os.path.join(os.path.dirname(__file__), "..", "db_adapters", "test", "test.sqlite"),
    )
    trace_db_path = os.environ.get(
        "TRACE_DB_PATH",
        os.path.join(os.path.dirname(__file__), "..", "trace_logs.sqlite"),
    )
    sqlite_db = SQLiteAdapter(os.path.abspath(db_path))
    trace_store = SQLiteTraceStore(os.path.abspath(trace_db_path))
    schema_provider = SQLiteSchemaProvider(sqlite_db)
    trace_store.sync_database_metadata("main_db", schema_provider.get_schema(), str(db_path))

    controller = get_agent_controller()

    _global_handler = QueryHandler(
        decision_model=controller,
        state_engine=DefaultQueryStateEngine(),
        validator=DeterministicValidator(),
        compiler=SQLiteCompiler(),
        database=SQLiteDatabaseAdapter(sqlite_db),
        trace_store=trace_store,
        schema_provider=schema_provider,
    )
    return _global_handler


# ============================================================================
# Request models
# ============================================================================


class CreateQueryRequest(BaseModel):
    request: str = Field(
        min_length=1,
        description="Natural-language database query.",
    )


class ApplyActionRequest(BaseModel):
    """
    HTTP representation of a typed query action.

    Example:

        {
            "action_type": "FILTER",
            "parameters": {
                "column": "gpa",
                "operator": ">",
                "value": 8
            }
        }
    """

    action_type: str = Field(
        min_length=1,
    )

    parameters: dict[str, Any] = Field(
        default_factory=dict,
    )


class CreateCheckpointRequest(BaseModel):
    label: str | None = None
    state_id: str | None = None


class RecoverQueryRequest(BaseModel):
    checkpoint_id: str

    correction: ApplyActionRequest


# ============================================================================
# Response models
# ============================================================================


class QuerySessionResponse(BaseModel):
    id: str
    request: str
    root_state_id: str
    current_state_id: str
    status: QueryStatus
    model_version: str | None = None
    created_at: str | None = None
    updated_at: str | None = None

    @classmethod
    def from_session(
        cls,
        session: QuerySession,
    ) -> QuerySessionResponse:
        return cls(
            id=session.id,
            request=session.request,
            root_state_id=session.root_state_id,
            current_state_id=session.current_state_id,
            status=session.status,
            model_version=session.model_version,
            created_at=session.created_at,
            updated_at=session.updated_at,
        )


class SessionSummaryResponse(BaseModel):
    id: str
    request: str
    status: QueryStatus
    model_version: str | None = None
    created_at: str | None = None
    updated_at: str | None = None
    state_count: int = 0
    has_failure: bool = False


class QueryStateResponse(BaseModel):
    id: str
    parent_id: str | None
    status: QueryStatus
    action_count: int
    sql: str | None
    preview: dict[str, Any] | None = None
    action: dict[str, Any] | None = None
    decision: dict[str, Any] | None = None

    @classmethod
    def from_state(
        cls,
        state: QueryState,
    ) -> QueryStateResponse:
        preview = None

        if state.preview is not None:
            preview = {
                "columns": list(state.preview.columns),
                "rows": list(state.preview.rows),
                "row_count": state.preview.row_count,
                "truncated": state.preview.truncated,
                "execution_time_ms": (
                    state.preview.execution_time_ms
                ),
            }

        action_data = None
        decision_data = None
        if state.actions:
            last_action = state.actions[-1]
            action_data = serialize_action(last_action)
            conf = getattr(last_action, "confidence", None)
            if conf is not None:
                decision_data = {
                    "confidence": conf,
                }

        return cls(
            id=state.id,
            parent_id=state.parent_id,
            status=state.status,
            action_count=len(state.actions),
            sql=state.sql,
            preview=preview,
            action=action_data,
            decision=decision_data,
        )


class ActionResponse(BaseModel):
    success: bool
    state: QueryStateResponse
    failure: dict[str, str] | None = None

    @classmethod
    def from_result(
        cls,
        result: ActionResult,
    ) -> ActionResponse:
        failure = None

        if result.failure is not None:
            failure = {
                "action_type": result.failure.action_type,
                "code": result.failure.code,
                "message": result.failure.message,
            }

        return cls(
            success=result.success,
            state=QueryStateResponse.from_state(
                result.state,
            ),
            failure=failure,
        )


class CheckpointResponse(BaseModel):
    id: str
    state_id: str
    label: str | None

    @classmethod
    def from_checkpoint(
        cls,
        checkpoint: Checkpoint,
    ) -> CheckpointResponse:
        return cls(
            id=checkpoint.id,
            state_id=checkpoint.state_id,
            label=checkpoint.label,
        )


class NextActionResponse(BaseModel):
    action_type: str
    parameters: dict[str, Any]


class StepResponse(ActionResponse):
    decision: NextActionResponse | None = None


class ColumnInfo(BaseModel):
    name: str
    data_type: str
    nullable: bool = True
    primary_key: bool = False


class TableInfo(BaseModel):
    name: str
    columns: list[ColumnInfo]
    row_count_estimate: int | None = None


class SchemaResponse(BaseModel):
    tables: list[TableInfo]


class QueryResultResponse(BaseModel):
    state: QueryStateResponse
    sql: str
    columns: list[str]
    rows: list[dict[str, Any]]
    row_count: int
    execution_time_ms: float
    total_actions: int | None = None
    model_version: str | None = None

    @classmethod
    def from_result(
        cls,
        result: QueryResult,
        session: QuerySession | None = None,
    ) -> QueryResultResponse:
        return cls(
            state=QueryStateResponse.from_state(
                result.state,
            ),
            sql=result.sql,
            columns=list(result.columns),
            rows=list(result.rows),
            row_count=result.row_count,
            execution_time_ms=result.execution_time_ms,
            total_actions=len(result.state.actions),
            model_version=session.model_version if session else None,
        )


class QueryTraceResponse(BaseModel):
    session: QuerySessionResponse
    states: list[QueryStateResponse]
    checkpoints: list[CheckpointResponse]
    failures: list[dict[str, str]]

    @classmethod
    def from_trace(
        cls,
        trace: QueryTrace,
    ) -> QueryTraceResponse:
        return cls(
            session=QuerySessionResponse.from_session(
                trace.session,
            ),
            states=[
                QueryStateResponse.from_state(state)
                for state in trace.states
            ],
            checkpoints=[
                CheckpointResponse.from_checkpoint(checkpoint)
                for checkpoint in trace.checkpoints
            ],
            failures=[
                {
                    "action_type": failure.action_type,
                    "code": failure.code,
                    "message": failure.message,
                }
                for failure in trace.failures
            ],
        )


# ============================================================================
# Action factory
# ============================================================================


def build_action(
    request: ApplyActionRequest,
) -> QueryAction:
    """
    Convert an HTTP action DTO into a concrete QueryAction.

    Keep this as an explicit whitelist.

    Do not accept SQL or dynamically instantiate arbitrary classes from
    action_type.
    """
    atype = request.action_type.upper()
    p = request.parameters

    from handlers.actions import (
        AbortQueryAction,
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

    if atype == "SELECT_TABLE":
        if "table" not in p:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="table parameter required")
        return SelectTableAction(table=p["table"])

    elif atype == "SELECT_COLUMN":
        if "column" not in p:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="column parameter required")
        return SelectColumnAction(column=p["column"], table=p.get("table"), alias=p.get("alias"))

    elif atype == "FILTER":
        if "column" not in p or "operator" not in p or "value" not in p:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="column, operator, and value parameters required",
            )
        return FilterAction(
            column=p["column"],
            operator=p["operator"],
            value=p["value"],
            table=p.get("table"),
        )

    elif atype == "JOIN":
        if "table" not in p or "left_on" not in p or "right_on" not in p:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="table, left_on, and right_on parameters required",
            )
        return JoinAction(
            table=p["table"],
            left_on=p["left_on"],
            right_on=p["right_on"],
            join_type=p.get("join_type", "INNER"),
        )

    elif atype == "GROUP_BY":
        if "column" not in p:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="column parameter required")
        return GroupByAction(column=p["column"], table=p.get("table"))

    elif atype == "ORDER_BY":
        if "column" not in p:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="column parameter required")
        return OrderByAction(column=p["column"], direction=p.get("direction", "ASC"), table=p.get("table"))

    elif atype == "LIMIT":
        if "limit" not in p:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="limit parameter required")
        return LimitAction(limit=int(p["limit"]))

    elif atype == "FINISH":
        return FinishAction()

    elif atype == "INSUFFICIENT_INFO":
        if "reason" not in p:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="reason parameter required")
        return InsufficientInfoAction(
            reason=p["reason"],
            clarification=p.get("clarification"),
            missing_fields=p.get("missing_fields"),
        )

    elif atype == "SCHEMA_MISSING":
        if "reason" not in p:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="reason parameter required")
        return SchemaMissingAction(
            reason=p["reason"],
            table=p.get("table"),
            column=p.get("column"),
            expected_relationship=p.get("expected_relationship"),
        )

    elif atype == "ABORT_QUERY":
        return AbortQueryAction()

    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail=f"Unsupported action_type: {request.action_type}",
    )


def serialize_action(
    action: QueryAction,
) -> dict[str, Any]:
    """
    Serialize a typed action for the API response.
    """

    if hasattr(action, "to_dict"):
        data = action.to_dict()

        if not isinstance(data, dict):
            raise TypeError(
                "QueryAction.to_dict() must return a dict."
            )

        return data

    if hasattr(action, "__dict__"):
        return {
            key: value
            for key, value in vars(action).items()
            if not key.startswith("_")
        }

    return {}


# ============================================================================
# Query routes
# ============================================================================


@router.post(
    "",
    response_model=QuerySessionResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_query(
    body: CreateQueryRequest,
    handler: QueryHandler = Depends(get_query_handler),
) -> QuerySessionResponse:
    """
    Create a new query session.
    """

    try:
        session = handler.create(
            body.request,
        )

    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc

    return QuerySessionResponse.from_session(
        session,
    )


@router.get(
    "",
    response_model=list[SessionSummaryResponse],
)
def list_queries(
    status: str | None = None,
    q: str | None = None,
    limit: int = 50,
    handler: QueryHandler = Depends(get_query_handler),
) -> list[SessionSummaryResponse]:
    """
    List historical query sessions with filtering and search.
    """

    sessions = handler.list_sessions(
        status=status,
        q=q,
        limit=limit,
    )

    return [
        SessionSummaryResponse(
            id=s["id"],
            request=s["request"],
            status=s["status"],
            model_version=s.get("model_version"),
            created_at=str(s["created_at"]) if s.get("created_at") is not None else None,
            updated_at=str(s["updated_at"]) if s.get("updated_at") is not None else None,
            state_count=s.get("state_count", 0),
            has_failure=bool(s.get("has_failure", False)),
        )
        for s in sessions
    ]


@router.get(
    "/schema",
    response_model=SchemaResponse,
)
def get_schema(
    handler: QueryHandler = Depends(get_query_handler),
) -> SchemaResponse:
    """
    Get available database schema including tables and columns.
    """

    db_schema = handler.schema_provider.get_schema()
    tables: list[TableInfo] = []

    if db_schema and hasattr(db_schema, "tables"):
        for t in db_schema.tables:
            cols: list[ColumnInfo] = []
            for c in getattr(t, "columns", []):
                cols.append(
                    ColumnInfo(
                        name=c.name,
                        data_type=c.data_type,
                        nullable=getattr(c, "nullable", True),
                        primary_key=getattr(c, "primary_key", False),
                    )
                )
            tables.append(
                TableInfo(
                    name=t.name,
                    columns=cols,
                    row_count_estimate=getattr(t, "row_count_estimate", None),
                )
            )

    return SchemaResponse(tables=tables)


@router.get("/agent/status")
def get_agent_status(controller=Depends(get_agent_controller)) -> dict[str, Any]:
    """Get currently active decision model adapter info."""
    return {
        "active_agent": controller.active_agent_type,
        "registered": list(controller._registry.keys()),
        "model_name": controller.model_name,
        "base_url": controller.base_url,
    }


@router.post("/agent/select")
def select_agent(body: dict[str, str], controller=Depends(get_agent_controller)) -> dict[str, str]:
    """Switch active adapter between 'ornith', 'rule', or future 'laya'."""
    agent_type = body.get("agent_type")
    if not agent_type:
        raise HTTPException(status_code=400, detail="agent_type required")
    try:
        controller.switch_to(agent_type)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"status": "ok", "active_agent": controller.active_agent_type}


@router.get(
    "/{session_id}",
    response_model=QueryStateResponse,
)
def get_query(
    session_id: str,
    handler: QueryHandler = Depends(get_query_handler),
) -> QueryStateResponse:
    """
    Get the current state of a query.
    """

    try:
        state = handler.get_state(
            session_id,
        )

    except KeyError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Query session not found.",
        ) from exc

    return QueryStateResponse.from_state(
        state,
    )


@router.post(
    "/{session_id}/step",
    response_model=StepResponse,
)
def step_query(
    session_id: str,
    handler: QueryHandler = Depends(get_query_handler),
) -> StepResponse:
    """
    Decide the next action and apply it in a single step.
    """

    try:
        result, decided_action = handler.step(
            session_id,
        )

    except KeyError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Query session not found.",
        ) from exc

    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc

    action_resp = ActionResponse.from_result(result)
    decision = NextActionResponse(
        action_type=decided_action.action_type,
        parameters=serialize_action(decided_action),
    )

    return StepResponse(
        success=action_resp.success,
        state=action_resp.state,
        failure=action_resp.failure,
        decision=decision,
    )


@router.post(
    "/{session_id}/next-action",
    response_model=NextActionResponse,
)
def next_action(
    session_id: str,
    handler: QueryHandler = Depends(get_query_handler),
) -> NextActionResponse:
    """
    Ask the decision model for the next typed action.

    This does not execute the action.
    """

    try:
        action = handler.next_action(
            session_id,
        )

    except KeyError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Query session not found.",
        ) from exc

    return NextActionResponse(
        action_type=action.action_type,
        parameters=serialize_action(action),
    )


@router.post(
    "/{session_id}/actions",
    response_model=ActionResponse,
)
def apply_action(
    session_id: str,
    body: ApplyActionRequest,
    handler: QueryHandler = Depends(get_query_handler),
) -> ActionResponse:
    """
    Apply one typed query action.

    Raw SQL is never accepted by this endpoint.
    """

    action = build_action(body)

    try:
        result = handler.apply_action(
            session_id,
            action,
        )

    except KeyError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Query session not found.",
        ) from exc

    return ActionResponse.from_result(
        result,
    )


@router.post(
    "/{session_id}/checkpoints",
    response_model=CheckpointResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_checkpoint(
    session_id: str,
    body: CreateCheckpointRequest | None = None,
    handler: QueryHandler = Depends(get_query_handler),
) -> CheckpointResponse:
    """
    Create a checkpoint at the current or specified query state.
    """

    label = body.label if body is not None else None
    state_id = body.state_id if body is not None else None

    try:
        checkpoint = handler.checkpoint(
            session_id,
            state_id=state_id,
            label=label,
        )

    except KeyError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Query session or state not found.",
        ) from exc

    return CheckpointResponse.from_checkpoint(
        checkpoint,
    )


@router.post(
    "/{session_id}/recover",
    response_model=ActionResponse,
)
def recover_query(
    session_id: str,
    body: RecoverQueryRequest,
    handler: QueryHandler = Depends(get_query_handler),
) -> ActionResponse:
    """
    Create a new branch from a checkpoint and apply a correction.
    """

    correction = build_action(
        body.correction,
    )

    try:
        result = handler.recover(
            session_id=session_id,
            checkpoint_id=body.checkpoint_id,
            correction=correction,
        )

    except KeyError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=(
                "Query session or checkpoint not found."
            ),
        ) from exc

    return ActionResponse.from_result(
        result,
    )


@router.post(
    "/{session_id}/finish",
    response_model=QueryResultResponse,
)
def finish_query(
    session_id: str,
    handler: QueryHandler = Depends(get_query_handler),
) -> QueryResultResponse:
    """
    Execute the current query and return the final result.
    """

    try:
        session = handler.trace_store.get_session(session_id)
        result = handler.finish(
            session_id,
        )

    except KeyError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Query session not found.",
        ) from exc

    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc

    return QueryResultResponse.from_result(
        result,
        session=session,
    )


@router.get(
    "/{session_id}/trace",
    response_model=QueryTraceResponse,
)
def get_trace(
    session_id: str,
    handler: QueryHandler = Depends(get_query_handler),
) -> QueryTraceResponse:
    """
    Return the complete query execution trace.

    React Flow can use this response to reconstruct the query graph.
    """

    try:
        trace = handler.get_trace(
            session_id,
        )

    except KeyError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Query session not found.",
        ) from exc

    return QueryTraceResponse.from_trace(
        trace,
    )
