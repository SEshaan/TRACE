from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

_TEST_DIR = Path(__file__).resolve().parent
_WORKSPACE_ROOT = _TEST_DIR.parents[2]
if str(_WORKSPACE_ROOT) not in sys.path:
    sys.path.insert(0, str(_WORKSPACE_ROOT))
if str(_TEST_DIR.parent) not in sys.path:
    sys.path.insert(0, str(_TEST_DIR.parent))

from Backend.db_adapters.sqlite_adapter import SQLiteAdapter
from Backend.handlers.schema_provider import SQLiteSchemaProvider


def test_get_schema_reads_database_changes_after_provider_creation(
    tmp_path: Path,
) -> None:
    database_path = tmp_path / "schema.sqlite"
    with sqlite3.connect(database_path) as connection:
        connection.execute("CREATE TABLE original_table (id INTEGER PRIMARY KEY)")

    provider = SQLiteSchemaProvider(SQLiteAdapter(str(database_path)))
    initial_schema = provider.get_schema()
    assert initial_schema.has_table("original_table")
    assert not initial_schema.has_table("new_table")

    with sqlite3.connect(database_path) as connection:
        connection.execute("CREATE TABLE new_table (id INTEGER PRIMARY KEY)")

    refreshed_schema = provider.get_schema()
    assert refreshed_schema.has_table("new_table")
