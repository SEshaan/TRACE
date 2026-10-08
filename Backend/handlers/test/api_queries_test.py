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
    assert finish_data["total_actions"] is not None
    assert finish_data["sql"] == "SELECT * FROM students\nWHERE gpa < 8.5"
    assert finish_data["execution_sql"] == 'SELECT * FROM "students"\nWHERE "gpa" < ?'

    # 7. Get Trace
    trace_resp = client.get(f"/queries/{session_id}/trace")
    assert trace_resp.status_code == 200
    trace_data = trace_resp.json()
    assert len(trace_data["checkpoints"]) == 1
    assert len(trace_data["states"]) >= 3
    filtered_state = next(
        state for state in trace_data["states"]
        if state["sql"] and '"gpa" < ?' in state["sql"]
    )
    assert filtered_state["display_sql"] == "SELECT * FROM students\nWHERE gpa < 8.5"


def test_api_aggregate_action(client: TestClient):
    create_resp = client.post("/queries", json={"request": "Sum student GPAs"})
    assert create_resp.status_code == 201
    session_id = create_resp.json()["id"]

    table_resp = client.post(
        f"/queries/{session_id}/actions",
        json={"action_type": "SELECT_TABLE", "parameters": {"table": "students"}},
    )
    assert table_resp.status_code == 200
    assert table_resp.json()["success"] is True

    aggregate_resp = client.post(
        f"/queries/{session_id}/actions",
        json={
            "action_type": "AGGREGATE",
            "parameters": {
                "function": "SUM",
                "column": "gpa",
                "alias": "total_gpa",
            },
        },
    )
    assert aggregate_resp.status_code == 200
    aggregate_data = aggregate_resp.json()
    assert aggregate_data["success"] is True
    assert aggregate_data["state"]["preview"]["columns"] == ["total_gpa"]

    finish_resp = client.post(f"/queries/{session_id}/finish")
    assert finish_resp.status_code == 200
    assert finish_resp.json()["rows"][0]["total_gpa"] == pytest.approx(68.1)


def test_api_accepts_order_by_aggregate_action(client: TestClient):
    create_resp = client.post(
        "/queries",
        json={"request": "Count students by GPA"},
    )
    assert create_resp.status_code == 201
    session_id = create_resp.json()["id"]

    table_resp = client.post(
        f"/queries/{session_id}/actions",
        json={"action_type": "SELECT_TABLE", "parameters": {"table": "students"}},
    )
    assert table_resp.json()["success"] is True

    aggregate_resp = client.post(
        f"/queries/{session_id}/actions",
        json={
            "action_type": "AGGREGATE",
            "parameters": {"function": "COUNT", "column": "id", "table": "students"},
        },
    )
    assert aggregate_resp.json()["success"] is True

    order_resp = client.post(
        f"/queries/{session_id}/actions",
        json={
            "action_type": "ORDER_BY",
            "parameters": {
                "column": "id",
                "direction": "DESC",
                "table": "students",
                "aggregate_function": "COUNT",
            },
        },
    )
    assert order_resp.status_code == 200
    assert order_resp.json()["success"] is True
    assert 'ORDER BY COUNT("students"."id") DESC' in order_resp.json()["state"]["sql"]


def test_api_step_endpoint(client: TestClient):
    create_resp = client.post("/queries", json={"request": "Students in Computer Science"})
    assert create_resp.status_code == 201
    session_id = create_resp.json()["id"]

    # Call /step (decide + apply in one call)
    step_resp = client.post(f"/queries/{session_id}/step")
    assert step_resp.status_code == 200
    step_data = step_resp.json()
    assert step_data["success"] is True
    assert "decision" in step_data
    assert step_data["decision"]["action_type"] in ["SELECT_TABLE", "SELECT_COLUMN", "FILTER", "JOIN", "LIMIT", "FINISH"]
    assert step_data["state"]["action_count"] >= 1


def test_api_list_sessions(client: TestClient):
    # Create two queries
    c1 = client.post("/queries", json={"request": "List high GPA students"})
    c2 = client.post("/queries", json={"request": "Find engineering courses"})
    assert c1.status_code == 201
    assert c2.status_code == 201

    # List all
    list_resp = client.get("/queries")
    assert list_resp.status_code == 200
    sessions = list_resp.json()
    assert isinstance(sessions, list)
    assert len(sessions) >= 2

    # Verify query search filtering
    filtered_resp = client.get("/queries?q=engineering")
    assert filtered_resp.status_code == 200
    filtered = filtered_resp.json()
    assert len(filtered) >= 1
    assert "engineering" in filtered[0]["request"].lower()


def test_api_schema(client: TestClient):
    schema_resp = client.get("/queries/schema")
    assert schema_resp.status_code == 200
    data = schema_resp.json()
    assert "tables" in data
    table_names = [t["name"] for t in data["tables"]]
    assert "students" in table_names
    students_tbl = next(t for t in data["tables"] if t["name"] == "students")
    col_names = [c["name"] for c in students_tbl["columns"]]
    assert "id" in col_names
    assert "name" in col_names
    assert "gpa" in col_names


def test_api_checkpoint_with_state_id(client: TestClient):
    create_resp = client.post("/queries", json={"request": "Students table"})
    session_id = create_resp.json()["id"]

    act_resp = client.post(
        f"/queries/{session_id}/actions",
        json={"action_type": "SELECT_TABLE", "parameters": {"table": "students"}},
    )
    state_id = act_resp.json()["state"]["id"]

    cp_resp = client.post(
        f"/queries/{session_id}/checkpoints",
        json={"label": "explicit_state_cp", "state_id": state_id},
    )
    assert cp_resp.status_code == 201
    assert cp_resp.json()["state_id"] == state_id


def test_api_insufficient_info_fail_action(client: TestClient):
    create_resp = client.post("/queries", json={"request": "Students table"})
    session_id = create_resp.json()["id"]

    resp = client.post(
        f"/queries/{session_id}/actions",
        json={
            "action_type": "INSUFFICIENT_INFO",
            "parameters": {
                "reason": "GPA threshold not specified",
                "clarification": "What GPA range?",
                "missing_fields": ["gpa_threshold"],
            },
        },
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["success"] is True
    # Fail actions record a decision node, not SQL.
    assert data["state"]["sql"] is None
    assert data["state"]["status"] == "failed"
    assert data["state"]["action"]["action_type"] == "INSUFFICIENT_INFO"


def test_api_branch_with_clarification_does_not_add_graph_state(
    client: TestClient,
):
    create_resp = client.post(
        "/queries",
        json={"request": "Students with a high GPA"},
    )
    session_id = create_resp.json()["id"]
    action_resp = client.post(
        f"/queries/{session_id}/actions",
        json={
            "action_type": "SELECT_TABLE",
            "parameters": {"table": "students"},
        },
    )
    state_id = action_resp.json()["state"]["id"]
    checkpoint_resp = client.post(
        f"/queries/{session_id}/checkpoints",
        json={"state_id": state_id, "label": "students-selected"},
    )
    checkpoint_id = checkpoint_resp.json()["id"]

    branch_resp = client.post(
        f"/queries/{session_id}/branch",
        json={
            "checkpoint_id": checkpoint_id,
            "clarification": "High GPA means at least 8.5.",
        },
    )

    assert branch_resp.status_code == 200
    assert branch_resp.json()["current_state_id"] == state_id
    assert branch_resp.json()["status"] == "active"
    assert branch_resp.json()["request"].endswith(
        "User clarification: High GPA means at least 8.5."
    )
    trace_resp = client.get(f"/queries/{session_id}/trace")
    assert len(trace_resp.json()["states"]) == 2


def test_api_trace_includes_validation_failure_node(client: TestClient):
    create_resp = client.post(
        "/queries",
        json={"request": "Read from a missing table"},
    )
    session_id = create_resp.json()["id"]

    apply_resp = client.post(
        f"/queries/{session_id}/actions",
        json={
            "action_type": "SELECT_TABLE",
            "parameters": {"table": "missing_table"},
        },
    )
    assert apply_resp.status_code == 200
    failed_state = apply_resp.json()["state"]
    assert apply_resp.json()["success"] is False
    assert failed_state["status"] == "failed"
    assert failed_state["action"]["action_type"] == "SELECT_TABLE"
    assert apply_resp.json()["failure"]["state_id"] == failed_state["id"]

    trace_resp = client.get(f"/queries/{session_id}/trace")
    assert trace_resp.status_code == 200
    trace = trace_resp.json()
    graph_state = next(
        state for state in trace["states"] if state["id"] == failed_state["id"]
    )
    assert graph_state["status"] == "failed"
    assert graph_state["parent_id"] == failed_state["parent_id"]
    assert trace["failures"][0]["state_id"] == failed_state["id"]


def test_api_schema_missing_fail_action(client: TestClient):
    create_resp = client.post("/queries", json={"request": "Students table"})
    session_id = create_resp.json()["id"]

    resp = client.post(
        f"/queries/{session_id}/actions",
        json={
            "action_type": "SCHEMA_MISSING",
            "parameters": {
                "reason": "No enrollments table in schema",
                "table": "enrollments",
            },
        },
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["success"] is True
    assert data["state"]["sql"] is None
    assert data["state"]["action"]["action_type"] == "SCHEMA_MISSING"


def test_api_abort_query_fail_action(client: TestClient):
    # ABORT_QUERY must be allowed even on an empty root state.
    create_resp = client.post("/queries", json={"request": "Impossible query"})
    session_id = create_resp.json()["id"]

    resp = client.post(
        f"/queries/{session_id}/actions",
        json={"action_type": "ABORT_QUERY", "parameters": {}},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["success"] is True
    assert data["state"]["sql"] is None
    assert data["state"]["action"]["action_type"] == "ABORT_QUERY"


def test_api_insufficient_info_requires_reason(client: TestClient):
    create_resp = client.post("/queries", json={"request": "Students table"})
    session_id = create_resp.json()["id"]

    resp = client.post(
        f"/queries/{session_id}/actions",
        json={"action_type": "INSUFFICIENT_INFO", "parameters": {}},
    )
    assert resp.status_code == 422
