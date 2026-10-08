from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import Mock

import pytest

_TEST_DIR = Path(__file__).resolve().parent
_WORKSPACE_ROOT = _TEST_DIR.parents[2]
if str(_WORKSPACE_ROOT) not in sys.path:
    sys.path.insert(0, str(_WORKSPACE_ROOT))
if str(_TEST_DIR.parent) not in sys.path:
    sys.path.insert(0, str(_TEST_DIR.parent))

from Backend.db_adapters.sqlite_adapter import SQLiteAdapter
from Backend.handlers.sqlite_trace_store import SQLiteTraceStore
from Backend.handlers import (
    AbortQueryAction,
    AggregateAction,
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


def test_compiler_orders_by_aggregate_expression():
    from Backend.handlers.query_handler import QueryState

    state = QueryState(
        id="aggregate-order",
        parent_id="aggregate",
        actions=(
            SelectTableAction(table="students"),
            AggregateAction(
                function="COUNT",
                column="id",
                table="students",
            ),
            OrderByAction(
                column="id",
                direction="DESC",
                table="students",
                aggregate_function="COUNT",
            ),
            LimitAction(limit=1),
        ),
        status=QueryStatus.ACTIVE,
    )

    sql, parameters = SQLiteCompiler().compile(state=state)

    assert 'ORDER BY COUNT("students"."id") DESC' in sql
    assert sql.endswith("LIMIT 1")
    assert parameters == ()


def test_validator_and_compiler_accept_qualified_join_keys(handler: QueryHandler):
    session = handler.create("Join students to departments")
    assert handler.apply_action(
        session.id,
        SelectTableAction(table="students"),
    ).success

    joined = handler.apply_action(
        session.id,
        JoinAction(
            table="departments",
            left_on="students.department_id",
            right_on="id",
        ),
    )

    assert joined.success
    assert 'ON "students"."department_id" = "departments"."id"' in joined.state.sql


def test_validator_only_allows_ordering_by_an_existing_aggregate(handler: QueryHandler):
    session = handler.create("Count students")
    handler.apply_action(session.id, SelectTableAction(table="students"))
    handler.apply_action(
        session.id,
        AggregateAction(function="COUNT", column="id", table="students"),
    )

    valid = handler.apply_action(
        session.id,
        OrderByAction(
            column="id",
            direction="DESC",
            table="students",
            aggregate_function="COUNT",
        ),
    )
    assert valid.success

    invalid = handler.apply_action(
        session.id,
        OrderByAction(
            column="gpa",
            direction="DESC",
            table="students",
            aggregate_function="SUM",
        ),
    )
    assert not invalid.success
    assert invalid.failure is not None
    assert "must match an AGGREGATE action" in invalid.failure.message


def test_validation_failure_handling(handler: QueryHandler):
    session = handler.create("Find invalid table")

    # Select nonexistent table
    res = handler.apply_action(session.id, SelectTableAction(table="nonexistent_table"))
    assert res.success is False
    assert res.failure is not None
    assert res.failure.code == "VALIDATION_FAILED"
    assert "does not exist in schema" in res.failure.message

    # The rejected action is retained as a failed child in the trace.
    trace = handler.get_trace(session.id)
    assert len(trace.failures) == 1
    assert trace.failures[0].action_type == "SELECT_TABLE"
    assert trace.failures[0].state_id == res.state.id
    assert res.state.status == QueryStatus.FAILED
    assert res.state.parent_id == session.root_state_id
    assert res.state.actions[-1].action_type == "SELECT_TABLE"


@pytest.mark.parametrize(
    ("failure_stage", "expected_code"),
    [
        ("compile", "SQL_COMPILATION_FAILED"),
        ("execute", "DATABASE_EXECUTION_FAILED"),
    ],
)
def test_pipeline_failures_are_returned_with_sqlite_trace_store(
    handler: QueryHandler,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    failure_stage: str,
    expected_code: str,
):
    trace_store = SQLiteTraceStore(str(tmp_path / "trace.sqlite"))
    handler.trace_store = trace_store
    session = handler.create("Query students")

    if failure_stage == "compile":
        monkeypatch.setattr(
            handler.compiler,
            "compile",
            Mock(side_effect=RuntimeError("compiler failure")),
        )
        expected_message = "compiler failure"
    else:
        monkeypatch.setattr(
            handler.database,
            "execute",
            Mock(side_effect=RuntimeError("database failure")),
        )
        expected_message = "database failure"

    result = handler.apply_action(
        session.id,
        SelectTableAction(table="students"),
    )

    assert not result.success
    assert result.failure is not None
    assert result.failure.code == expected_code
    assert result.failure.message == expected_message
    assert trace_store.get_session(session.id).status == QueryStatus.FAILED
    assert trace_store.get_session(session.id).current_state_id == result.state.id
    assert result.state.status == QueryStatus.FAILED
    assert result.state.parent_id is not None
    assert result.state.actions[-1].action_type == "SELECT_TABLE"
    trace = trace_store.get_trace(session.id)
    assert len(trace.failures) == 1
    assert trace.failures[0].code == expected_code
    assert any(state.id == result.state.id for state in trace.states)


def test_ambiguous_select_column_creates_failed_graph_node(
    handler: QueryHandler,
    tmp_path: Path,
):
    trace_store = SQLiteTraceStore(str(tmp_path / "ambiguous-trace.sqlite"))
    handler.trace_store = trace_store
    session = handler.create("Select student and department names")

    table_result = handler.apply_action(
        session.id,
        SelectTableAction(table="students"),
    )
    assert table_result.success
    join_result = handler.apply_action(
        session.id,
        JoinAction(
            table="departments",
            left_on="department_id",
            right_on="id",
        ),
    )
    assert join_result.success

    result = handler.apply_action(
        session.id,
        SelectColumnAction(column="name"),
    )

    assert not result.success
    assert result.failure is not None
    assert result.failure.code == "VALIDATION_FAILED"
    assert "Column 'name' is ambiguous" in result.failure.message
    assert "specify the table" in result.failure.message
    assert result.state.status == QueryStatus.FAILED
    assert result.state.parent_id == join_result.state.id
    assert result.state.actions[-1].action_type == "SELECT_COLUMN"
    trace = trace_store.get_trace(session.id)
    failed_nodes = [state for state in trace.states if state.status == QueryStatus.FAILED]
    assert len(failed_nodes) == 1
    assert failed_nodes[0].id == result.state.id


def test_agent_retries_from_parent_with_failed_sibling_and_reason(handler: QueryHandler):
    session = handler.create("Select student name after joining departments")
    assert handler.apply_action(
        session.id,
        SelectTableAction(table="students"),
    ).success
    join_result = handler.apply_action(
        session.id,
        JoinAction(table="departments", left_on="department_id", right_on="id"),
    )
    assert join_result.success

    class RetryDecisionModel:
        def __init__(self):
            self.contexts = []
            self.actions = [
                SelectColumnAction(column="name"),
                SelectColumnAction(column="name", table="students"),
            ]

        def decide(self, *, request, state, environment, graph_context=None):
            self.contexts.append(graph_context)
            return self.actions.pop(0)

    decision_model = RetryDecisionModel()
    handler.decision_model = decision_model

    result, decided_action = handler.step(session.id)

    assert result.success
    assert decided_action.table == "students"
    assert len(decision_model.contexts) == 2
    failed_sibling = decision_model.contexts[1]["failed_siblings"][0]
    assert failed_sibling["action_type"] == "SELECT_COLUMN"
    assert failed_sibling["parameters"] == {"column": "name", "table": None, "alias": None}
    assert "ambiguous" in failed_sibling["reason"]

    trace = handler.get_trace(session.id)
    failed_state = next(state for state in trace.states if state.status == QueryStatus.FAILED)
    current_session = handler.trace_store.get_session(session.id)
    assert failed_state.parent_id == join_result.state.id
    assert current_session.current_state_id == result.state.id
    assert result.state.parent_id == join_result.state.id


def test_select_column_uses_table_qualification_after_join(handler: QueryHandler):
    session = handler.create("Select student name after joining departments")
    assert handler.apply_action(
        session.id,
        SelectTableAction(table="students"),
    ).success
    assert handler.apply_action(
        session.id,
        JoinAction(table="departments", left_on="department_id", right_on="id"),
    ).success

    result = handler.apply_action(
        session.id,
        SelectColumnAction(column="name", table="students"),
    )

    assert result.success
    assert result.state.sql == 'SELECT "students"."name" FROM "students"\nINNER JOIN "departments" ON "students"."department_id" = "departments"."id"'


def test_aggregate_action_compiles_and_executes(handler: QueryHandler):
    session = handler.create("Sum student GPA")
    table_result = handler.apply_action(
        session.id,
        SelectTableAction(table="students"),
    )
    assert table_result.success

    aggregate_result = handler.apply_action(
        session.id,
        AggregateAction(function="SUM", column="gpa", alias="total_gpa"),
    )
    assert aggregate_result.success
    assert aggregate_result.state.sql == (
        'SELECT SUM("gpa") AS "total_gpa" FROM "students"'
    )
    assert aggregate_result.preview is not None
    assert aggregate_result.preview.rows[0]["total_gpa"] == pytest.approx(68.1)

    result = handler.finish(session.id)
    assert result.sql == aggregate_result.state.sql
    assert result.rows[0]["total_gpa"] == pytest.approx(68.1)


def test_count_all_with_group_by(handler: QueryHandler):
    session = handler.create("Count students per department")
    assert handler.apply_action(
        session.id,
        SelectTableAction(table="students"),
    ).success
    assert handler.apply_action(
        session.id,
        GroupByAction(column="department_id"),
    ).success
    result = handler.apply_action(
        session.id,
        AggregateAction(function="COUNT", column="*", alias="student_count"),
    )

    assert result.success
    assert result.state.sql == (
        'SELECT COUNT(*) AS "student_count" FROM "students"\n'
        'GROUP BY "department_id"'
    )
    assert sum(row["student_count"] for row in result.preview.rows) == 8


@pytest.mark.parametrize(
    ("function", "column", "message"),
    [
        ("MEDIAN", "gpa", "Invalid aggregate function"),
        ("SUM", "*", "Only COUNT can aggregate '*'"),
    ],
)
def test_aggregate_action_rejects_invalid_input(handler, function, column, message):
    session = handler.create("Aggregate student data")
    assert handler.apply_action(
        session.id,
        SelectTableAction(table="students"),
    ).success
    result = handler.apply_action(
        session.id,
        AggregateAction(function=function, column=column),
    )

    assert not result.success
    assert result.failure is not None
    assert message in result.failure.message


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


def test_branch_with_clarification_updates_prompt_without_adding_state(
    handler: QueryHandler,
):
    session = handler.create("Students with a high GPA")
    selected = handler.apply_action(
        session.id,
        SelectTableAction(table="students"),
    )
    checkpoint = handler.checkpoint(
        session.id,
        state_id=selected.state.id,
        label="students-selected",
    )

    branched = handler.branch_with_clarification(
        session.id,
        checkpoint.id,
        "High GPA means at least 8.5.",
    )
    trace = handler.get_trace(session.id)

    assert branched.request == (
        "Students with a high GPA\n\n"
        "User clarification: High GPA means at least 8.5."
    )
    assert branched.current_state_id == selected.state.id
    assert branched.status == QueryStatus.ACTIVE
    assert len(trace.states) == 2
    assert all(state.sql for state in trace.states if state.id == selected.state.id)


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
