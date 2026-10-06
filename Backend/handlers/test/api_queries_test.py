from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

_TEST_DIR = Path(__file__).resolve().parent
_WORKSPACE_ROOT = _TEST_DIR.parents[2]
if str(_WORKSPACE_ROOT) not in sys.path:
    sys.path.insert(0, str(_WORKSPACE_ROOT))
if str(_WORKSPACE_ROOT / "Backend") not in sys.path:
    sys.path.insert(0, str(_WORKSPACE_ROOT / "Backend"))

from Backend.main import app
from Backend.db_adapters.sqlite_adapter import SQLiteAdapter
from Backend.handlers import (
    DeterministicValidator,
    DefaultQueryStateEngine,
    InMemoryTraceStore,
    QueryHandler,
    RuleBasedDecisionModel,
    SQLiteCompiler,
    SQLiteDatabaseAdapter,
    SQLiteSchemaProvider,
)
from Backend.api.queries import set_query_handler


@pytest.fixture(autouse=True)
def setup_api_handler():
    db_path = _WORKSPACE_ROOT / "Backend" / "db_adapters" / "test" / "test.sqlite"
    sqlite_adapter = SQLiteAdapter(str(db_path))
    handler = QueryHandler(
        decision_model=RuleBasedDecisionModel(),
        state_engine=DefaultQueryStateEngine(),
        validator=DeterministicValidator(),
        compiler=SQLiteCompiler(),
        database=SQLiteDatabaseAdapter(sqlite_adapter),
        trace_store=InMemoryTraceStore(),
        schema_provider=SQLiteSchemaProvider(sqlite_adapter),
        preview_limit=10,
    )
    set_query_handler(handler)


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def test_api_health(client: TestClient):
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_api_full_query_workflow(client: TestClient):
    # 1. Create query session
    create_resp = client.post("/queries", json={"request": "Find students with high GPA"})
    assert create_resp.status_code == 201
    session_data = create_resp.json()
    session_id = session_data["id"]

    # 2. SELECT_TABLE action
    action_table_resp = client.post(
        f"/queries/{session_id}/actions",
        json={"action_type": "SELECT_TABLE", "parameters": {"table": "students"}},
    )
    assert action_table_resp.status_code == 200
    table_data = action_table_resp.json()
    assert table_data["success"] is True
    assert table_data["state"]["preview"]["row_count"] == 8

    # 3. Create checkpoint
    cp_resp = client.post(
        f"/queries/{session_id}/checkpoints",
        json={"label": "base_selected"},
    )
    assert cp_resp.status_code == 201
    cp_id = cp_resp.json()["id"]

    # 4. FILTER action
    filter_resp = client.post(
        f"/queries/{session_id}/actions",
        json={
            "action_type": "FILTER",
            "parameters": {"column": "gpa", "operator": ">", "value": 9.0},
        },
    )
    assert filter_resp.status_code == 200
    filter_data = filter_resp.json()
    assert filter_data["success"] is True
    assert filter_data["state"]["preview"]["row_count"] == 2

    # 5. Recover from checkpoint with different filter
    recover_resp = client.post(
        f"/queries/{session_id}/recover",
        json={
            "checkpoint_id": cp_id,
            "correction": {
                "action_type": "FILTER",
                "parameters": {"column": "gpa", "operator": "<", "value": 8.5},
            },
        },
    )
    assert recover_resp.status_code == 200
    rec_data = recover_resp.json()
    assert rec_data["success"] is True

    # 6. Finish query
    finish_resp = client.post(f"/queries/{session_id}/finish")
    assert finish_resp.status_code == 200
    finish_data = finish_resp.json()
    assert finish_data["row_count"] > 0
    assert len(finish_data["rows"]) == finish_data["row_count"]

    # 7. Get Trace
    trace_resp = client.get(f"/queries/{session_id}/trace")
    assert trace_resp.status_code == 200
    trace_data = trace_resp.json()
    assert len(trace_data["checkpoints"]) == 1
    assert len(trace_data["states"]) >= 3
