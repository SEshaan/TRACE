"""Shared pytest fixtures for the backend test suite.

The fixture database is built from a single source of truth — the seeder's
``seed.sql`` — so tests never depend on a committed SQLite binary (see Task B2).
Building happens once per session into a temporary directory; the adapter opens
this file read-only at runtime, which is all these read-only tests need.
"""

from __future__ import annotations

import os
import sqlite3
from pathlib import Path

import pytest

_SEED_SQL = Path(__file__).resolve().parents[0] / "db_adapters" / "seeder" / "seed.sql"


@pytest.fixture(scope="session")
def test_db_path(tmp_path_factory) -> Path:
    """Path to a fixture DB built from ``seed.sql`` (single source of truth)."""
    tmp_dir = tmp_path_factory.mktemp("test_db")
    db_file = tmp_dir / "test.sqlite"
    conn = sqlite3.connect(str(db_file))
    try:
        with _SEED_SQL.open("r", encoding="utf-8") as handle:
            conn.executescript(handle.read())
        conn.commit()
    finally:
        conn.close()

    # Publish the built path so any lazily-built default handler (e.g.
    # api.queries.get_query_handler, which reads DATABASE_PATH / TRACE_DB_PATH)
    # resolves to this same real database instead of a stale/deleted binary.
    os.environ.setdefault("DATABASE_PATH", str(db_file))
    trace_db = tmp_path_factory.mktemp("trace") / "trace_logs.sqlite"
    os.environ.setdefault("TRACE_DB_PATH", str(trace_db))

    return db_file


@pytest.fixture(scope="session")
def database(test_db_path) -> "SQLiteAdapter":
    """Read-only adapter over the shared fixture DB."""
    from Backend.db_adapters.sqlite_adapter import SQLiteAdapter

    return SQLiteAdapter(str(test_db_path))
