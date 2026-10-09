"""Smoke tests for ``Backend/main.py``: app construction, the health probe,
and CORS wiring.

These guard against regressions where the FastAPI app fails to build or the
CORS middleware is misconfigured (which would break browser clients). They only
touch the ``/health`` endpoint and CORS headers, so no fixture database is
required.
"""

from __future__ import annotations

import sys
from pathlib import Path

_TEST_DIR = Path(__file__).resolve().parent
_WORKSPACE_ROOT = _TEST_DIR.parents[2]
if str(_WORKSPACE_ROOT) not in sys.path:
    sys.path.insert(0, str(_WORKSPACE_ROOT))

from fastapi.testclient import TestClient

from Backend.main import app, create_app


def test_create_app_builds_fresh_instance():
    # Rebuilding the app must not raise (no import-time side effects).
    rebuilt = create_app()
    assert rebuilt is not None
    assert len(rebuilt.routes) >= 1


def test_health_endpoint_returns_ok():
    client = TestClient(app)
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_cors_headers_present_on_origin_request():
    client = TestClient(app)
    response = client.get(
        "/health",
        headers={"Origin": "http://example.com"},
    )

    # Wildcard origin config echoes the request's origin.
    assert response.headers["access-control-allow-origin"] == "http://example.com"
    assert response.headers["access-control-allow-credentials"] == "true"


def test_cors_preflight_allows_methods_and_headers():
    client = TestClient(app)
    response = client.options(
        "/queries",
        headers={
            "Origin": "http://example.com",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type,authorization",
        },
    )

    assert response.status_code == 200
    assert "POST" in response.headers["access-control-allow-methods"]
    assert "content-type" in response.headers["access-control-allow-headers"]


def test_cors_middleware_is_registered():
    cors = [
        middleware.cls
        for middleware in app.user_middleware
        if middleware.cls.__name__ == "CORSMiddleware"
    ]
    assert len(cors) == 1
