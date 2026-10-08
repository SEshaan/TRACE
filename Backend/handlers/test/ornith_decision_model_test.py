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

from Backend.db_adapters.schema import ColumnSchema, TableSchema
from Backend.handlers import (
    AbortQueryAction,
    AggregateAction,
    FinishAction,
    InsufficientInfoAction,
    SchemaMissingAction,
    SelectTableAction,
)
from Backend.handlers.query_handler import QueryStatus, QueryState
from Backend.ml_adapters.ornith_decision_model import OrnithDecisionModel


def _make_schema():
    def _t(name):
        return type("T", (), {"columns": [ColumnSchema(name="id", data_type="int")]})()

    schema = type(
        "S",
        (),
        {
            "tables": [
                TableSchema(
                    name="students",
                    columns=[
                        ColumnSchema(name="id", data_type="int"),
                        ColumnSchema(name="name", data_type="text"),
                        ColumnSchema(name="gpa", data_type="float"),
                    ],
                ),
                TableSchema(
                    name="departments",
                    columns=[ColumnSchema(name="id", data_type="int")],
                    foreign_keys=[],
                ),
            ],
            "table": _t,
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

    def predict(self, state=None, questions=None):
        self.calls.append(questions)
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
