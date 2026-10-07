"""
seed_demos.py
---------------------------------------------------------------------------
Seed 3 finished demo sessions into the trace store so they show up in session
history and render as previously-executed graphs — no live agent required.

Each demo is a *scripted* sequence of deterministic actions replayed through
the same QueryHandler the API uses, so the persisted traces are byte-for-byte
compatible with real runs (real previews, real SQL, real branch edges).

Run from the Backend directory:

    cd Backend && python seed_demos.py

Re-running appends more demo sessions. Use `--clear` to delete prior [DEMO]
sessions first so session history stays tidy during prep.
"""

from __future__ import annotations

import os
import sys
import sqlite3
from pathlib import Path

# Make `handlers` / `db_adapters` importable when run from the Backend dir.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from handlers.actions import (  # noqa: E402
    FilterAction,
    FinishAction,
    InsufficientInfoAction,
    OrderByAction,
    SelectColumnAction,
    SelectTableAction,
)
from handlers.query_handler import QueryStatus  # noqa: E402


# ---------------------------------------------------------------------------
# Demo scripts
# ---------------------------------------------------------------------------

def _select_table(session_id, table):
    return SelectTableAction(table=table)


def _select_column(session_id, column, table=None):
    return SelectColumnAction(column=column, table=table)


def _filter(session_id, column, operator, value, table=None):
    return FilterAction(column=column, operator=operator, value=value, table=table)


def _order_by(session_id, column, direction="ASC", table=None):
    return OrderByAction(column=column, direction=direction, table=table)


def _finish(session_id):
    return FinishAction()


def _decline(session_id):
    return InsufficientInfoAction(
        reason=(
            "This schema contains students, courses, and departments only. There is no "
            "employee or hiring data to answer the request."
        ),
        clarification=(
            "Provide an employees/hiring table, or rephrase the request around students, "
            "courses, or departments."
        ),
    )


# `kind` controls how the terminal session status is set after replay:
#   completed -> handler.finish() marks the last state COMPLETED (green terminal)
#   active    -> left ACTIVE (used for the recovery-branch demo)
#   declined  -> left FAILED by the graceful-fail action (amber decline node)
DEMO_SCRIPTS = [
    {
        "title": "List students with GPA above 9.0, highest first",
        "summary": "A clean linear success: base table -> projection -> filter -> sort -> finish.",
        "kind": "completed",
        "steps": [
            lambda sid: _select_table(sid, "students"),
            lambda sid: _select_column(sid, "name", "students"),
            lambda sid: _select_column(sid, "gpa", "students"),
            lambda sid: _filter(sid, "gpa", ">", 9.0),
            lambda sid: _order_by(sid, "gpa", "DESC"),
            lambda sid: _finish(sid),
        ],
    },
    {
        "title": "Students with GPA above 8.5, then filtered by department",
        "summary": "A recovery branch: an abandoned filter (grey) and a recovered path (blue).",
        "kind": "active",
        "steps": [
            lambda sid: _select_table(sid, "students"),       # A
            lambda sid: _filter(sid, "gpa", ">", 8.5),        # B (checkpoint source)
            ("checkpoint", "base"),                            # checkpoint on B
            # An alternative exploration off B that will be abandoned (grey inactive edge).
            lambda sid: _filter(sid, "gpa", "<", 9.0),
            # Recover from the 'base' checkpoint with a department filter -> blue recovered branch.
            ("recover", "base", lambda sid: _filter(sid, "department_id", "=", 1)),
        ],
    },
    {
        "title": "Employees who will be hired starting in 2031",
        "summary": "A graceful decline (amber-dashed): the agent stops instead of inventing data.",
        "kind": "declined",
        "steps": [
            lambda sid: _select_table(sid, "students"),
            lambda sid: _decline(sid),
        ],
    },
]


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

def build_handler():
    from db_adapters.sqlite_adapter import SQLiteAdapter
    from handlers.compiler import SQLiteCompiler
    from handlers.query_handler import QueryHandler
    from handlers.db_adapter import SQLiteDatabaseAdapter
    from handlers.schema_provider import SQLiteSchemaProvider
    from handlers.sqlite_trace_store import SQLiteTraceStore
    from handlers.state_engine import DefaultQueryStateEngine
    from handlers.validator import DeterministicValidator

    # Resolve relative to this file so CWD (and git-bash path translation) does not matter.
    # This script lives directly in Backend/, so __file__.parent is the Backend
    # folder (the real API uses .parent.parent because it sits under api/).
    backend_dir = Path(__file__).resolve().parent
    db_path = os.environ.get(
        "DATABASE_PATH",
        str(backend_dir / "db_adapters" / "test" / "test.sqlite"),
    )
    trace_db_path = os.environ.get(
        "TRACE_DB_PATH",
        str(backend_dir / "trace_logs.sqlite"),
    )
    sqlite_db = SQLiteAdapter(db_path)
    trace_store = SQLiteTraceStore(trace_db_path)
    schema_provider = SQLiteSchemaProvider(sqlite_db)
    trace_store.sync_database_metadata("main_db", schema_provider.get_schema(), str(db_path))

    handler = QueryHandler(
        decision_model=None,  # never called — actions are scripted
        state_engine=DefaultQueryStateEngine(),
        validator=DeterministicValidator(),
        compiler=SQLiteCompiler(),
        database=SQLiteDatabaseAdapter(sqlite_db),
        trace_store=trace_store,
        schema_provider=schema_provider,
    )
    return handler, trace_db_path


def _apply_sequence(handler, session_id, steps):
    """Apply a scripted sequence.

    Honours two special markers (they reference each other by label):
      ('checkpoint', label)          -> mark current state as a recovery point
      ('recover', label, factory)    -> recover from the checkpoint created with
                                        that same label, applying `factory` to it
                                        (creates a branch off that node)
    Everything else is applied via apply_action().
    """
    checkpoints = {}
    for step in steps:
        if isinstance(step, tuple):
            kind = step[0]
            if kind == "checkpoint":
                cp = handler.checkpoint(session_id, label=step[1])
                checkpoints[step[1]] = cp
                print(f"      • checkpoint '{step[1]}'")
                continue
            if kind == "recover":
                label, factory = step[1], step[2]
                cp = checkpoints[label]
                print(f"      • recover from checkpoint '{label}'")
                result = handler.recover(session_id, cp.id, [factory(session_id)])
                if not result.success:
                    raise RuntimeError(f"recover failed: {result.failure}")
                continue
            raise ValueError(f"Unknown step marker: {kind!r}")
        result = handler.apply_action(session_id, step(session_id))
        if not result.success:
            raise RuntimeError(f"Step failed: {result.failure}")


def _clear_existing_demos(trace_db_path):
    conn = sqlite3.connect(trace_db_path)
    try:
        rows = conn.execute(
            "SELECT id FROM query_sessions WHERE request LIKE '[DEMO]%'"
        ).fetchall()
        for (sid,) in rows:
            for table in (
                "query_states", "exploration_nodes", "checkpoints",
                "failure_logs", "execution_logs", "training_samples",
            ):
                conn.execute(f"DELETE FROM {table} WHERE session_id = ?", (sid,))
            conn.execute("DELETE FROM query_sessions WHERE id = ?", (sid,))
        conn.commit()
        return len(rows)
    finally:
        conn.close()


def main():
    import argparse

    parser = argparse.ArgumentParser(description="Seed demo sessions into the trace store.")
    parser.add_argument(
        "--clear",
        action="store_true",
        help="Delete prior [DEMO] sessions before seeding.",
    )
    args = parser.parse_args()

    from handlers.query_handler import QueryHandler

    handler, trace_db_path = build_handler()
    trace_store = handler.trace_store

    if args.clear:
        removed = _clear_existing_demos(trace_db_path)
        if removed:
            print(f"Cleared {removed} previous demo session(s).\n")

    print("Seeding demo sessions...\n")
    for demo in DEMO_SCRIPTS:
        request = f"[DEMO] {demo['title']}"
        session = handler.create(request)
        _apply_sequence(handler, session.id, demo["steps"])

        if demo["kind"] == "completed":
            # Mark the terminal state COMPLETED with a full (unbounded) execution.
            handler.finish(session.id)

        trace = handler.get_trace(session.id)
        print(f"  ✓ {demo['title']}")
        print(f"      status={trace.session.status.value}  "
              f"states={len(trace.states)}  checkpoints={len(trace.checkpoints)}  "
              f"failures={len(trace.failures)}")
        print(f"      session_id={session.id}")

    print("\nDone. These sessions now appear in session history and load as demos.")


if __name__ == "__main__":
    main()
