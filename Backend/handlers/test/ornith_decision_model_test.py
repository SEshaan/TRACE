from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

_TEST_DIR = Path(__file__).resolve().parent
_WORKSPACE_ROOT = _TEST_DIR.parents[2]
if str(_WORKSPACE_ROOT) not in sys.path:
    sys.path.insert(0, str(_WORKSPACE_ROOT))
if str(_TEST_DIR.parent) not in sys.path:
    sys.path.insert(0, str(_TEST_DIR.parent))

from Backend.db_adapters.schema import ColumnSchema, ForeignKeySchema, TableSchema
from Backend.handlers import (
    AbortQueryAction,
    AggregateAction,
    FinishAction,
    GroupByAction,
    JoinAction,
    InsufficientInfoAction,
    OrderByAction,
    SchemaMissingAction,
    SelectTableAction,
)
from Backend.handlers.query_handler import QueryStatus, QueryState
from Backend.ml_adapters.ornith_decision_model import OrnithDecisionModel


def _make_schema():
    tables = [
        TableSchema(
            name="students",
            columns=[
                ColumnSchema(name="id", data_type="int", primary_key=True),
                ColumnSchema(name="name", data_type="text"),
                ColumnSchema(name="gpa", data_type="float"),
                ColumnSchema(name="department_id", data_type="int"),
            ],
            foreign_keys=[
                ForeignKeySchema(
                    column="department_id",
                    referenced_table="departments",
                    referenced_column="id",
                )
            ],
        ),
        TableSchema(
            name="departments",
            columns=[
                ColumnSchema(name="id", data_type="int"),
                ColumnSchema(name="name", data_type="text"),
            ],
            foreign_keys=[],
        ),
        TableSchema(
            name="courses",
            columns=[
                ColumnSchema(name="id", data_type="int", primary_key=True),
                ColumnSchema(name="title", data_type="text"),
            ],
            foreign_keys=[],
        ),
    ]
    tables_by_name = {table.name: table for table in tables}
    schema = type(
        "S",
        (),
        {
            "tables": tables,
            "table": staticmethod(lambda name: tables_by_name.get(name)),
        },
    )
    return schema


class _FakeAgent:
    """Minimal stand-in for OrnithDecisionAgent used to drive decide() paths."""

    def __init__(self, *, choice, reason="needed", clarification=None, table=None):
        self._choice = choice
        self._reason = reason
        self._clarification = clarification
        self._table = table
        self.calls = []
        self.states = []

    def predict(self, state=None, questions=None):
        self.calls.append(questions)
        self.states.append(state)
        return {
            "answers": {
                key: {"choice": self._choice, "answer_confidence": 0.9}
                for key in questions
            }
        }

    def _complete(self, prompt):
        if prompt.startswith("Given the user goal:"):
            return "{}"
        payload = {"reason": self._reason}
        if self._clarification is not None:
            payload["clarification"] = self._clarification
        if self._table is not None:
            payload["table"] = self._table
        return json.dumps(payload)

    def _parse_json(self, text):
        return json.loads(text)


class _AggregateFakeAgent(_FakeAgent):
    def predict(self, state=None, questions=None):
        self.calls.append(questions)
        if "operation" in questions:
            answers = {"operation": {"choice": "aggregate", "answer_confidence": 0.95}}
        elif "function" in questions:
            answers = {"function": {"choice": "SUM", "answer_confidence": 0.9}}
        else:
            answers = {"column": {"choice": "gpa", "answer_confidence": 0.85}}
        return {"answers": answers}


class _GroupByFakeAgent(_FakeAgent):
    def __init__(self, *, operation_choice="group_by", column_choice="department_id"):
        super().__init__(choice=operation_choice)
        self.operation_choice = operation_choice
        self.column_choice = column_choice

    def predict(self, state=None, questions=None):
        self.calls.append(questions)
        self.states.append(state)
        if "operation" in questions:
            choice = self.operation_choice
        else:
            choice = self.column_choice
        return {
            "answers": {
                key: {"choice": choice, "answer_confidence": 0.9}
                for key in questions
            }
        }


class _QualifiedColumnFakeAgent(_FakeAgent):
    def predict(self, state=None, questions=None):
        self.calls.append(questions)
        self.states.append(state)
        choice = "select_column" if "operation" in questions else "students.name"
        return {
            "answers": {
                key: {"choice": choice, "answer_confidence": 0.9}
                for key in questions
            }
        }


class _OrderByAggregateFakeAgent(_FakeAgent):
    def predict(self, state=None, questions=None):
        self.calls.append(questions)
        self.states.append(state)
        answers = {}
        for name in questions:
            choice = {
                "operation": "order_by",
                "column": "COUNT(students.id)",
                "direction": "DESC",
            }[name]
            answers[name] = {"choice": choice, "answer_confidence": 0.9}
        return {"answers": answers}


class _JoinFakeAgent(_FakeAgent):
    def predict(self, state=None, questions=None):
        self.calls.append(questions)
        self.states.append(state)
        name = next(iter(questions))
        choice = "join" if name == "operation" else "students.department_id -> departments.id"
        return {
            "answers": {
                name: {"choice": choice, "answer_confidence": 0.9}
            }
        }


class _LimitFakeAgent(_FakeAgent):
    def predict(self, state=None, questions=None):
        self.calls.append(questions)
        name = next(iter(questions))
        choice = "limit" if name == "operation" else self._choice
        return {"answers": {name: {"choice": choice, "answer_confidence": 0.9}}}

    def _complete(self, prompt):
        if "Extract the requested result count" in prompt:
            return '{"limit": 1}'
        return super()._complete(prompt)


class _CountFakeAgent(_FakeAgent):
    def predict(self, state=None, questions=None):
        self.calls.append(questions)
        self.states.append(state)
        if "operation" in questions:
            name, choice = "operation", "aggregate"
        elif "function" in questions:
            name, choice = "function", "COUNT"
        else:
            name = "column"
            choice = "students.id" if "students.id" in questions["column"]["criteria"] else "id"
        return {"answers": {name: {"choice": choice, "answer_confidence": 0.9}}}


def _root_state():
    return QueryState(id="s", parent_id=None, actions=(), status=QueryStatus.NEW)


def _post_root_state():
    return QueryState(
        id="s",
        parent_id=None,
        actions=(SelectTableAction(table="students"),),
        status=QueryStatus.ACTIVE,
    )


_SCHEMA = _make_schema()


def test_decide_offers_abort_query_at_root_and_emits_it():
    agent = _FakeAgent(choice="abort_query", reason="references a nonexistent entity")
    model = OrnithDecisionModel(agent=agent)

    action = model.decide(
        request="List the flying purple elephants",
        state=_root_state(),
        environment=_SCHEMA,
    )

    assert isinstance(action, AbortQueryAction)
    assert action.reason == "references a nonexistent entity"
    assert action.confidence == 0.9


@pytest.mark.parametrize(
    ("choice", "expected_type"),
    [
        ("insufficient_info", InsufficientInfoAction),
        ("schema_missing", SchemaMissingAction),
    ],
)
def test_root_table_choice_always_offers_graceful_fails(choice, expected_type):
    agent = _FakeAgent(choice=choice, reason="cannot infer the requested value")
    model = OrnithDecisionModel(agent=agent)

    action = model.decide(
        request="Find students with high GPA",
        state=_root_state(),
        environment=_SCHEMA,
    )

    assert isinstance(action, expected_type)
    table_question = agent.calls[0]["table"]
    assert {"insufficient_info", "schema_missing", "abort_query"} <= set(table_question["criteria"])


def test_decide_emits_insufficient_info_with_clarification():
    agent = _FakeAgent(
        choice="insufficient_info",
        reason="GPA threshold not specified",
        clarification="What GPA range defines high?",
    )
    model = OrnithDecisionModel(agent=agent)

    action = model.decide(
        request="Find students with high GPA",
        state=_post_root_state(),
        environment=_SCHEMA,
    )

    assert isinstance(action, InsufficientInfoAction)
    assert action.reason == "GPA threshold not specified"
    assert action.clarification == "What GPA range defines high?"


def test_decide_emits_schema_missing_with_table():
    agent = _FakeAgent(
        choice="schema_missing",
        reason="No enrollments table exists",
        table="enrollments",
    )
    model = OrnithDecisionModel(agent=agent)

    action = model.decide(
        request="List every enrollment",
        state=_post_root_state(),
        environment=_SCHEMA,
    )

    assert isinstance(action, SchemaMissingAction)
    assert action.reason == "No enrollments table exists"
    assert action.table == "enrollments"


def test_decide_still_finishes_when_no_fail_choice_selected():
    agent = _FakeAgent(choice="finish")
    model = OrnithDecisionModel(agent=agent)

    action = model.decide(
        request="Find students with high GPA",
        state=_post_root_state(),
        environment=_SCHEMA,
    )

    assert isinstance(action, FinishAction)  # post-root + finish choice -> terminal
    operation_question = agent.calls[0]["operation"]
    assert {"insufficient_info", "schema_missing", "abort_query"} <= set(
        operation_question["criteria"]
    )
    assert "limit" not in operation_question["criteria"]
    assert "order_by" not in operation_question["criteria"]


def test_filter_choice_offers_graceful_fails_and_does_not_guess_missing_value():
    agent = _FakeAgent(choice="filter")
    model = OrnithDecisionModel(agent=agent)

    action = model.decide(
        request="Find students with high GPA",
        state=_post_root_state(),
        environment=_SCHEMA,
    )

    assert isinstance(action, InsufficientInfoAction)
    assert len(agent.calls) == 2
    filter_questions = agent.calls[1]
    for question in filter_questions.values():
        assert {"insufficient_info", "schema_missing", "abort_query"} <= set(question["criteria"])


def test_decide_creates_aggregate_action_when_requested():
    agent = _AggregateFakeAgent(choice="aggregate")
    model = OrnithDecisionModel(agent=agent)

    action = model.decide(
        request="Calculate the average GPA",
        state=_post_root_state(),
        environment=_SCHEMA,
    )

    assert isinstance(action, AggregateAction)
    assert action.function == "SUM"
    assert action.column == "gpa"
    assert action.confidence == 0.85
    assert "aggregate" in agent.calls[0]["operation"]["criteria"]


def test_decide_uses_group_by_action_for_category_requests():
    agent = _GroupByFakeAgent()
    model = OrnithDecisionModel(agent=agent)

    action = model.decide(
        request="Count students per department_id",
        state=_post_root_state(),
        environment=_SCHEMA,
    )

    assert isinstance(action, GroupByAction)
    assert action.column == "department_id"
    operation = agent.calls[0]["operation"]
    assert "group_by" in operation["criteria"]
    assert "aggregate" in operation["criteria"]
    assert "choose group_by on Y and then aggregate" in operation["instructions"]
    assert "function" not in action.to_dict()


def test_grouped_aggregation_request_cannot_be_misrouted_to_aggregate():
    agent = _GroupByFakeAgent(operation_choice="aggregate")
    model = OrnithDecisionModel(agent=agent)

    action = model.decide(
        request="Count students per department_id",
        state=_post_root_state(),
        environment=_SCHEMA,
    )

    assert isinstance(action, GroupByAction)
    assert action.column == "department_id"


def test_decide_qualifies_ambiguous_column_after_join():
    agent = _QualifiedColumnFakeAgent(choice="select_column")
    model = OrnithDecisionModel(agent=agent)
    state = QueryState(
        id="joined",
        parent_id="base",
        actions=(
            SelectTableAction(table="students"),
            JoinAction(
                table="departments",
                left_on="department_id",
                right_on="id",
            ),
        ),
        status=QueryStatus.ACTIVE,
    )

    action = model.decide(
        request="Show the student and department names",
        state=state,
        environment=_SCHEMA,
    )

    assert action.action_type == "SELECT_COLUMN"
    assert action.column == "name"
    assert action.table == "students"
    assert "students.name" in agent.calls[1]["column"]["criteria"]
    assert "departments.name" in agent.calls[1]["column"]["criteria"]


def test_join_action_space_contains_only_declared_relationships():
    agent = _JoinFakeAgent(choice="join")
    model = OrnithDecisionModel(agent=agent)

    action = model.decide(
        request="Join students to their department",
        state=_post_root_state(),
        environment=_SCHEMA,
    )

    assert isinstance(action, JoinAction)
    assert action.table == "departments"
    assert action.left_on == "students.department_id"
    assert action.right_on == "id"
    assert "students.department_id -> departments.id" in (
        agent.calls[1]["join_relationship"]["criteria"]
    )
    assert "courses" not in agent.calls[1]["join_relationship"]["criteria"]


def test_limit_uses_the_requested_top_one_value():
    agent = _LimitFakeAgent(choice="limit")
    model = OrnithDecisionModel(agent=agent)

    action = model.decide(
        request="Find the department with the most students",
        state=QueryState(
            id="ranked",
            parent_id="ordered",
            actions=(
                SelectTableAction(table="students"),
                JoinAction(
                    table="departments",
                    left_on="students.department_id",
                    right_on="id",
                ),
                GroupByAction(column="department_id", table="students"),
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
            ),
            status=QueryStatus.ACTIVE,
        ),
        environment=_SCHEMA,
    )

    from Backend.handlers import LimitAction

    assert isinstance(action, LimitAction)
    assert action.limit == 1
    assert "limit" in agent.calls[0]["operation"]["criteria"]


def test_ranking_action_space_requires_grouping_and_aggregate_before_sorting():
    agent = _JoinFakeAgent(choice="join")
    model = OrnithDecisionModel(agent=agent)

    join_action = model.decide(
        request="Find the department with the most students",
        state=_post_root_state(),
        environment=_SCHEMA,
    )

    assert isinstance(join_action, JoinAction)
    operation_criteria = agent.calls[0]["operation"]["criteria"]
    assert "join" in operation_criteria
    assert "group_by" not in operation_criteria
    assert "aggregate" not in operation_criteria
    assert "order_by" not in operation_criteria
    assert "limit" not in operation_criteria

    grouping_agent = _GroupByFakeAgent(operation_choice="finish")
    group_action = OrnithDecisionModel(agent=grouping_agent).decide(
        request="Find the department with the most students",
        state=QueryState(
            id="joined",
            parent_id="base",
            actions=_post_root_state().actions + (join_action,),
            status=QueryStatus.ACTIVE,
        ),
        environment=_SCHEMA,
    )
    assert isinstance(group_action, GroupByAction)
    joined_operations = grouping_agent.calls[0]["operation"]["criteria"]
    assert "group_by" in joined_operations
    assert "aggregate" in joined_operations
    assert "order_by" not in joined_operations
    assert "limit" not in joined_operations


def test_count_for_named_entity_is_limited_to_its_primary_key_or_all_rows():
    agent = _CountFakeAgent(choice="aggregate")
    model = OrnithDecisionModel(agent=agent)

    action = model.decide(
        request="Count students",
        state=QueryState(
            id="joined",
            parent_id="base",
            actions=(
                SelectTableAction(table="students"),
                JoinAction(
                    table="departments",
                    left_on="students.department_id",
                    right_on="id",
                ),
            ),
            status=QueryStatus.ACTIVE,
        ),
        environment=_SCHEMA,
    )

    assert isinstance(action, AggregateAction)
    assert action.function == "COUNT"
    assert action.column == "id"
    assert action.table == "students"
    assert set(agent.calls[1]["function"]["criteria"]) == {
        "COUNT",
        "insufficient_info",
        "schema_missing",
        "abort_query",
    }
    count_columns = agent.calls[2]["column"]["criteria"]
    assert "students.id" in count_columns
    assert "*" in count_columns
    assert "departments.id" not in count_columns
    assert "departments.name" not in count_columns
    assert "students.gpa" not in count_columns


def test_order_by_action_space_includes_existing_aggregate_outputs():
    from Backend.handlers import OrderByAction

    agent = _OrderByAggregateFakeAgent(choice="order_by")
    model = OrnithDecisionModel(agent=agent)
    state = QueryState(
        id="aggregated",
        parent_id="grouped",
        actions=(
            SelectTableAction(table="students"),
            JoinAction(
                table="departments",
                left_on="students.department_id",
                right_on="id",
            ),
            GroupByAction(column="department_id", table="students"),
            AggregateAction(function="COUNT", column="id", table="students"),
        ),
        status=QueryStatus.ACTIVE,
    )

    action = model.decide(
        request="Find the department with the most students",
        state=state,
        environment=_SCHEMA,
    )

    assert isinstance(action, OrderByAction)
    assert action.column == "id"
    assert action.table == "students"
    assert action.aggregate_function == "COUNT"
    assert "COUNT(students.id)" in agent.calls[1]["column"]["criteria"]


def test_sum_action_space_excludes_non_numeric_columns():
    agent = _AggregateFakeAgent(choice="aggregate")
    model = OrnithDecisionModel(agent=agent)

    action = model.decide(
        request="Calculate the sum of student GPA",
        state=_post_root_state(),
        environment=_SCHEMA,
    )

    assert isinstance(action, AggregateAction)
    function_criteria = agent.calls[1]["function"]["criteria"]
    assert "SUM" in function_criteria
    assert "AVG" in function_criteria
    assert "name" not in function_criteria
    column_criteria = agent.calls[2]["column"]["criteria"]
    assert "gpa" in column_criteria
    assert "name" not in column_criteria


def test_decide_passes_every_applied_action_and_parameter_to_agent():
    from Backend.handlers import FilterAction, OrderByAction, SelectColumnAction

    agent = _FakeAgent(choice="finish")
    model = OrnithDecisionModel(agent=agent)
    state = QueryState(
        id="s4",
        parent_id="s3",
        actions=(
            SelectTableAction(table="students"),
            SelectColumnAction(column="name"),
            FilterAction(column="gpa", operator=">", value=8.5),
            OrderByAction(column="gpa", direction="DESC"),
        ),
        status=QueryStatus.ACTIVE,
        sql='SELECT "name" FROM "students" WHERE "gpa" > ? ORDER BY "gpa" DESC',
    )

    action = model.decide(
        request="Find students above 8.5 GPA, highest GPA first",
        state=state,
        environment=_SCHEMA,
    )

    assert isinstance(action, FinishAction)
    state_summary = agent.states[0]
    assert '"action_type": "SELECT_TABLE"' in state_summary
    assert '"action_type": "SELECT_COLUMN"' in state_summary
    assert '"action_type": "FILTER"' in state_summary
    assert '"operator": ">"' in state_summary
    assert '"value": 8.5' in state_summary
    assert '"action_type": "ORDER_BY"' in state_summary
    assert '"direction": "DESC"' in state_summary
    assert "Do not repeat an operation with the same parameters" in state_summary


def test_decide_receives_failed_sibling_action_and_failure_reason():
    agent = _FakeAgent(choice="finish")
    model = OrnithDecisionModel(agent=agent)

    action = model.decide(
        request="Find students",
        state=_post_root_state(),
        environment=_SCHEMA,
        graph_context={
            "failed_siblings": [
                {
                    "state_id": "failed-1",
                    "depth": 2,
                    "action_type": "SELECT_COLUMN",
                    "parameters": {"column": "name"},
                    "code": "VALIDATION_FAILED",
                    "reason": "Column 'name' is ambiguous; specify the table.",
                },
            ],
            "sibling_actions": {},
            "recent_failures": [],
        },
    )

    assert isinstance(action, FinishAction)
    state_summary = agent.states[0]
    assert "Failed sibling at depth 2" in state_summary
    assert "VALIDATION_FAILED" in state_summary
    assert "Column 'name' is ambiguous; specify the table." in state_summary


def test_summarize_schema_lists_tables_and_foreign_keys():
    from Backend.ml_adapters.ornith_decision_model import _summarize_schema

    def _fk(referenced_table, referenced_column):
        return type("FK", (), {"referenced_table": referenced_table, "referenced_column": referenced_column})()

    students = TableSchema(
        name="students",
        columns=[ColumnSchema(name="id", data_type="int")],
        foreign_keys=[_fk("departments", "id")],
    )
    schema = type("S", (), {"tables": [students]})

    summary = _summarize_schema(schema)
    assert "students" in summary
    assert "departments.id" in summary


def test_summarize_schema_handles_empty():
    from Backend.ml_adapters.ornith_decision_model import _summarize_schema

    assert _summarize_schema(None).lower().startswith("no database schema")
