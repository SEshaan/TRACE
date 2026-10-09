from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

_TEST_DIR = Path(__file__).resolve().parent
_WORKSPACE_ROOT = _TEST_DIR.parents[2]
if str(_WORKSPACE_ROOT) not in sys.path:
    sys.path.insert(0, str(_WORKSPACE_ROOT))
if str(_WORKSPACE_ROOT / "Backend") not in sys.path:
    sys.path.insert(0, str(_WORKSPACE_ROOT / "Backend"))

from Backend.db_adapters.schema import ColumnSchema, DatabaseSchema, TableSchema
from Backend.handlers import (
    AgentController,
    QueryState,
    QueryStatus,
    SelectTableAction,
)
from Backend.ml_adapters.ornith_decision_model import OrnithDecisionModel


@pytest.fixture
def dummy_schema() -> DatabaseSchema:
    return DatabaseSchema(
        tables=[
            TableSchema(
                name="students",
                columns=[
                    ColumnSchema(name="id", data_type="INTEGER", primary_key=True),
                    ColumnSchema(name="name", data_type="TEXT"),
                    ColumnSchema(name="gpa", data_type="REAL"),
                ],
            )
        ]
    )


def test_agent_controller_switching():
    controller = AgentController(default_agent="rule")
    assert controller.active_agent_type == "rule"

    action = controller.decide(
        request="Find students",
        state=QueryState(id="1", parent_id=None, actions=(), status=QueryStatus.NEW),
        environment=None,
        graph_context={"sibling_actions": {}},
    )
    assert action.action_type == "SELECT_TABLE"

    # Register mock model
    mock_model = MagicMock()
    mock_model.decide.return_value = SelectTableAction(table="students", confidence=0.99)
    controller.register("custom", mock_model)

    controller.switch_to("custom")
    assert controller.active_agent_type == "custom"

    action = controller.decide(
        request="Find students",
        state=QueryState(id="1", parent_id=None, actions=(), status=QueryStatus.NEW),
        environment=None,
    )
    assert action.action_type == "SELECT_TABLE"
    assert action.confidence == 0.99


def test_ornith_decision_model_mocked(dummy_schema: DatabaseSchema):
    mock_agent = MagicMock()
    # Mock predict for table selection
    mock_agent.predict.return_value = {
        "model": "ornith-1.5",
        "answers": {
            "table": {
                "type": "choice",
                "choice": "students",
                "answer_confidence": 0.95,
            }
        },
    }

    model = OrnithDecisionModel(agent=mock_agent)
    state = QueryState(id="1", parent_id=None, actions=(), status=QueryStatus.NEW)

    action = model.decide(
        request="Show me all students",
        state=state,
        environment=dummy_schema,
    )

    assert isinstance(action, SelectTableAction)
    assert action.table == "students"
    assert action.confidence == 0.95
