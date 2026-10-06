from __future__ import annotations

import sys
from pathlib import Path

import pytest

_TEST_DIR = Path(__file__).resolve().parent
_WORKSPACE_ROOT = _TEST_DIR.parents[2]
if str(_WORKSPACE_ROOT) not in sys.path:
    sys.path.insert(0, str(_WORKSPACE_ROOT))
if str(_WORKSPACE_ROOT / "Backend") not in sys.path:
    sys.path.insert(0, str(_WORKSPACE_ROOT / "Backend"))

from Backend.db_adapters.sqlite_adapter import SQLiteAdapter
from Backend.handlers import (
    ActionFailure,
    Checkpoint,
    FilterAction,
    PreviewResult,
    QueryAction,
    QuerySession,
    QueryState,
    QueryStatus,
    SelectTableAction,
    SQLiteSchemaProvider,
    SQLiteTraceStore,
)


@pytest.fixture
def temp_trace_db(tmp_path: Path) -> SQLiteTraceStore:
    db_file = tmp_path / "test_trace.sqlite"
    return SQLiteTraceStore(str(db_file))


def test_sqlite_trace_store_session_and_states(temp_trace_db: SQLiteTraceStore):
    store = temp_trace_db

    root_state = QueryState(
        id="root_1",
        parent_id=None,
        actions=(),
        status=QueryStatus.NEW,
    )

    # 1. Create session
    session = store.create_session(
        request="Find students with gpa > 9.0",
        root_state=root_state,
        model_version="ornith-1.5-9b",
    )
    assert session.request == "Find students with gpa > 9.0"
    assert session.model_version == "ornith-1.5-9b"

    fetched_session = store.get_session(session.id)
    assert fetched_session.id == session.id

    # 2. Save root state
    store.save_state(session.id, root_state)
    fetched_root = store.get_state(root_state.id)
    assert fetched_root.id == "root_1"
    assert len(fetched_root.actions) == 0

    # 3. Save second state with action & preview
    action = SelectTableAction(table="students", confidence=0.98)
    preview = PreviewResult(
        columns=("id", "name"),
        rows=({"id": 1, "name": "Alice"},),
        row_count=1,
        truncated=False,
        execution_time_ms=1.2,
    )
    state2 = QueryState(
        id="state_2",
        parent_id="root_1",
        actions=(action,),
        status=QueryStatus.ACTIVE,
        sql='SELECT "id", "name" FROM "students"',
        preview=preview,
    )
    store.save_state(session.id, state2)
    store.update_session(session.id, current_state_id="state_2", status=QueryStatus.ACTIVE)

    fetched_state2 = store.get_state("state_2")
    assert fetched_state2.parent_id == "root_1"
    assert len(fetched_state2.actions) == 1
    assert fetched_state2.actions[0].action_type == "SELECT_TABLE"
    assert fetched_state2.actions[0].confidence == 0.98
    assert fetched_state2.preview is not None
    assert fetched_state2.preview.row_count == 1

    # 4. Save checkpoint
    cp = Checkpoint(id="cp_1", state_id="state_2", label="after_select_table")
    store.save_checkpoint(session_id=session.id, checkpoint=cp)
    fetched_cp = store.get_checkpoint("cp_1")
    assert fetched_cp.state_id == "state_2"
    assert fetched_cp.label == "after_select_table"

    # 5. Save failure
    fail_action = FilterAction(column="fake_col", operator="=", value=1)
    failure = ActionFailure(action_type="FILTER", code="VALIDATION_FAILED", message="Column not found")
    store.save_failure(session_id=session.id, state_id="state_2", action=fail_action, failure=failure)

    # 6. Get complete trace
    trace = store.get_trace(session.id)
    assert trace.session.id == session.id
    assert len(trace.states) == 2
    assert len(trace.checkpoints) == 1
    assert len(trace.failures) == 1
    assert trace.failures[0].error_code if hasattr(trace.failures[0], "error_code") else trace.failures[0].code == "VALIDATION_FAILED"


def test_sqlite_trace_store_schema_metadata_sync(temp_trace_db: SQLiteTraceStore):
    store = temp_trace_db
    test_db = _WORKSPACE_ROOT / "Backend" / "db_adapters" / "test" / "test.sqlite"
    adapter = SQLiteAdapter(str(test_db))
    provider = SQLiteSchemaProvider(adapter)
    schema = provider.get_schema()

    db_id = store.sync_database_metadata("test_db", schema, str(test_db))
    assert db_id is not None

    with store._get_connection() as conn:
        tables = conn.execute("SELECT name FROM tables").fetchall()
        table_names = [t["name"] for t in tables]
        assert "students" in table_names
        assert "departments" in table_names
        assert "courses" in table_names

        columns = conn.execute("SELECT name FROM columns").fetchall()
        col_names = [c["name"] for c in columns]
        assert "gpa" in col_names
