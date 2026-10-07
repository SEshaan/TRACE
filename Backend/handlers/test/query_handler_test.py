from __future__ import annotations

import sys
from pathlib import Path

import pytest

_TEST_DIR = Path(__file__).resolve().parent
_WORKSPACE_ROOT = _TEST_DIR.parents[2]
if str(_WORKSPACE_ROOT) not in sys.path:
    sys.path.insert(0, str(_WORKSPACE_ROOT))
if str(_TEST_DIR.parent) not in sys.path:
    sys.path.insert(0, str(_TEST_DIR.parent))

from Backend.db_adapters.sqlite_adapter import SQLiteAdapter
from Backend.handlers import (
    AbortQueryAction,
    DeterministicValidator,
    DefaultQueryStateEngine,
    FilterAction,
    FinishAction,
    GroupByAction,
    InsufficientInfoAction,
    InMemoryTraceStore,
    JoinAction,
    LimitAction,
    OrderByAction,
    QueryHandler,
    QueryResult,
    QueryStatus,
    RuleBasedDecisionModel,
    SchemaMissingAction,
    SelectColumnAction,
    SelectTableAction,
    SQLiteCompiler,
    SQLiteDatabaseAdapter,
    SQLiteSchemaProvider,
)


@pytest.fixture
def test_db_path() -> Path:
    db_path = _WORKSPACE_ROOT / "Backend" / "db_adapters" / "test" / "test.sqlite"
    assert db_path.exists(), f"Test database not found at {db_path}"
    return db_path.resolve()


@pytest.fixture
def handler(test_db_path: Path) -> QueryHandler:
    sqlite_adapter = SQLiteAdapter(str(test_db_path))
    return QueryHandler(
        decision_model=RuleBasedDecisionModel(),
        state_engine=DefaultQueryStateEngine(),
        validator=DeterministicValidator(),
        compiler=SQLiteCompiler(),
        database=SQLiteDatabaseAdapter(sqlite_adapter),
        trace_store=InMemoryTraceStore(),
        schema_provider=SQLiteSchemaProvider(sqlite_adapter),
        preview_limit=10,
    )


def test_session_creation(handler: QueryHandler):
    session = handler.create("Find all students with GPA > 8.5")
    assert session.id is not None
    assert session.status == QueryStatus.ACTIVE
    assert session.request == "Find all students with GPA > 8.5"

    state = handler.get_state(session.id)
    assert state.id == session.current_state_id
    assert state.parent_id is None
    assert len(state.actions) == 0


def test_apply_valid_actions_sequence(handler: QueryHandler):
    session = handler.create("Query students")

    # 1. SELECT_TABLE
    res1 = handler.apply_action(session.id, SelectTableAction(table="students"))
    assert res1.success is True
    assert res1.preview is not None
    assert res1.preview.row_count == 8
    assert "students" in res1.state.sql

    # 2. SELECT_COLUMN
    res2 = handler.apply_action(session.id, SelectColumnAction(column="name"))
    assert res2.success is True
    assert res2.preview.columns == ("name",)

    # 3. FILTER
    res3 = handler.apply_action(
        session.id,
        FilterAction(column="gpa", operator=">", value=9.0),
    )
    assert res3.success is True
    assert res3.preview.row_count == 2  # Diana (9.5), Alice (9.2)

    # 4. ORDER_BY
    res4 = handler.apply_action(
        session.id,
        OrderByAction(column="gpa", direction="DESC"),
    )
    assert res4.success is True
    assert res4.preview.rows[0]["name"] == "Diana"

    # 5. LIMIT
    res5 = handler.apply_action(session.id, LimitAction(limit=1))
    assert res5.success is True
    assert res5.preview.row_count == 1
    assert res5.preview.rows[0]["name"] == "Diana"

    # Finish
    finish_res = handler.finish(session.id)
    assert isinstance(finish_res, QueryResult)
    assert finish_res.row_count == 1
    assert finish_res.rows[0]["name"] == "Diana"


def test_validation_failure_handling(handler: QueryHandler):
    session = handler.create("Find invalid table")

    # Select nonexistent table
    res = handler.apply_action(session.id, SelectTableAction(table="nonexistent_table"))
    assert res.success is False
    assert res.failure is not None
    assert res.failure.code == "VALIDATION_FAILED"
    assert "does not exist in schema" in res.failure.message

    # Session status set to FAILED
    trace = handler.get_trace(session.id)
    assert len(trace.failures) == 1
    assert trace.failures[0].action_type == "SELECT_TABLE"


def test_checkpoint_and_recovery(handler: QueryHandler):
    session = handler.create("Students query with checkpoint")

    # Step 1: Select table
    res1 = handler.apply_action(session.id, SelectTableAction(table="students"))
    assert res1.success is True

    # Checkpoint here
    cp = handler.checkpoint(session.id, label="after_table")
    assert cp.state_id == res1.state.id

    # Step 2: Bad filter that produces no results or fails
    res_bad = handler.apply_action(
        session.id,
        FilterAction(column="gpa", operator="<", value=0.0),
    )
    assert res_bad.success is True
    assert res_bad.preview.row_count == 0

    # Recover from checkpoint with good filter
    recovery_res = handler.recover(
        session_id=session.id,
        checkpoint_id=cp.id,
        correction=FilterAction(column="gpa", operator=">", value=9.0),
    )
    assert recovery_res.success is True
    assert recovery_res.preview.row_count == 2

    # Check trace includes branching states
    trace = handler.get_trace(session.id)
    assert len(trace.checkpoints) == 1
    # Check that both branches exist
    assert len(trace.states) >= 4


def test_join_query(handler: QueryHandler):
    session = handler.create("Students with department names")

    res1 = handler.apply_action(session.id, SelectTableAction(table="students"))
    assert res1.success is True

    res2 = handler.apply_action(
        session.id,
        JoinAction(
            table="departments",
            left_on="department_id",
            right_on="id",
        ),
    )
    assert res2.success is True
    assert "JOIN" in res2.state.sql

    # Select columns from both
    res3 = handler.apply_action(session.id, SelectColumnAction(column="name", table="students", alias="student"))
    assert res3.success is True
    res4 = handler.apply_action(session.id, SelectColumnAction(column="name", table="departments", alias="department"))
    assert res4.success is True

    res_finish = handler.finish(session.id)
    assert res_finish.row_count > 0
    assert "student" in res_finish.columns
    assert "department" in res_finish.columns


def test_apply_insufficient_info_short_circuits(handler: QueryHandler):
    session = handler.create("Graceful fail query")

    res = handler.apply_action(
        session.id,
        InsufficientInfoAction(reason="GPA threshold not specified", clarification="What range?"),
    )
    assert res.success is True
    # Fail actions record a decision node, no SQL compiled.
    assert res.state.sql is None
    assert res.state.preview is None
    assert res.state.status == QueryStatus.FAILED
    assert res.state.actions[-1].action_type == "INSUFFICIENT_INFO"


def test_apply_schema_missing_short_circuits(handler: QueryHandler):
    session = handler.create("Graceful fail query")

    res = handler.apply_action(
        session.id,
        SchemaMissingAction(reason="No enrollments table", table="enrollments"),
    )
    assert res.success is True
    assert res.state.sql is None
    assert res.state.status == QueryStatus.FAILED
    assert res.state.actions[-1].action_type == "SCHEMA_MISSING"


def test_apply_abort_query_on_empty_state(handler: QueryHandler):
    session = handler.create("Graceful fail query")

    # ABORT_QUERY is allowed even on the empty root state.
    res = handler.apply_action(session.id, AbortQueryAction())
    assert res.success is True
    assert res.state.status == QueryStatus.FAILED
    assert res.state.actions[-1].action_type == "ABORT_QUERY"


def test_validator_rejects_empty_reason(handler: QueryHandler):
    session = handler.create("Graceful fail query")

    res = handler.apply_action(session.id, InsufficientInfoAction(reason=""))
    assert res.success is False
    assert res.failure is not None
    assert "reason" in res.failure.message
