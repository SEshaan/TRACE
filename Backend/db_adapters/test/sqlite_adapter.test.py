from __future__ import annotations

import dataclasses
import sqlite3
import sys
from pathlib import Path
from typing import Any

import pytest

# Ensure repository root and db_adapters package are importable
_TEST_DIR = Path(__file__).resolve().parent
_WORKSPACE_ROOT = _TEST_DIR.parents[2]
if str(_WORKSPACE_ROOT) not in sys.path:
    sys.path.insert(0, str(_WORKSPACE_ROOT))
if str(_TEST_DIR.parent) not in sys.path:
    sys.path.insert(0, str(_TEST_DIR.parent))

from Backend.db_adapters.schema import (
    ColumnSchema,
    DatabaseSchema,
    ForeignKeySchema,
    IndexSchema,
    TableSchema,
)
from Backend.db_adapters.sqlite_adapter import (
    QueryResult,
    SQLiteAdapter,
    SqlPreview,
)


@pytest.fixture
def test_db_path() -> Path:
    db_path = _TEST_DIR / "test.sqlite"
    assert db_path.exists(), f"Test database not found at {db_path}"
    return db_path


@pytest.fixture
def database(test_db_path: Path) -> SQLiteAdapter:
    return SQLiteAdapter(str(test_db_path))


@pytest.fixture
def memory_database() -> SQLiteAdapter:
    return SQLiteAdapter(":memory:")


# -----------------------------------------------------------------------------
# Read-Only Enforcement & SQL Guard Tests
# -----------------------------------------------------------------------------


def test_adapter_is_read_only(database: SQLiteAdapter) -> None:
    with pytest.raises(
        ValueError,
        match="only supports read-only SQL",
    ):
        database.query(
            """
            INSERT INTO students (name, gpa)
            VALUES ('Eve', 9.0)
            """
        )


@pytest.mark.parametrize(
    "sql",
    [
        "UPDATE students SET gpa = 10",
        "DELETE FROM students",
        "DROP TABLE students",
        "CREATE TABLE foo (id INTEGER)",
        "ALTER TABLE students ADD COLUMN foo TEXT",
        "REPLACE INTO students (id, name) VALUES (1, 'Eve')",
        "PRAGMA writable_schema = 1",
        "ATTACH DATABASE 'other.sqlite' AS other",
        "",
        "   ",
        "\n\t  ",
        "-- comment\nSELECT 1",
    ],
)
def test_mutating_sql_is_rejected(
    database: SQLiteAdapter,
    sql: str,
) -> None:
    with pytest.raises(
        ValueError,
        match="only supports read-only SQL",
    ):
        database.query(sql)


def test_connection_mode_ro_enforces_readonly_at_sqlite_engine_level(
    database: SQLiteAdapter,
) -> None:
    """
    Even if the query validator is bypassed, the underlying connection
    uses mode=ro and sqlite3 rejects writes at the C engine level.
    """
    conn = database.connect()
    try:
        with pytest.raises(sqlite3.OperationalError, match="readonly database"):
            conn.execute(
                "INSERT INTO departments (id, name) VALUES (99, 'Test')"
            )
    finally:
        conn.close()


def test_multi_statement_sql_is_rejected(database: SQLiteAdapter) -> None:
    """
    sqlite3 execute() does not permit multi-statement queries.
    """
    with pytest.raises(sqlite3.ProgrammingError, match="one statement at a time"):
        database.query("SELECT 1; DROP TABLE students;")


# -----------------------------------------------------------------------------
# Connection Management & Lifecycle Tests
# -----------------------------------------------------------------------------


def test_connect_properties(database: SQLiteAdapter) -> None:
    conn = database.connect()
    try:
        assert isinstance(conn, sqlite3.Connection)
        assert conn.row_factory is sqlite3.Row

        # Foreign keys should be active
        cursor = conn.execute("PRAGMA foreign_keys")
        assert cursor.fetchone()[0] == 1
    finally:
        conn.close()


def test_connection_context_manager_lifecycle(database: SQLiteAdapter) -> None:
    with database.connection() as conn:
        assert isinstance(conn, sqlite3.Connection)
        row = conn.execute("SELECT 1 AS num").fetchone()
        assert row["num"] == 1

    # After context exit, the connection must be closed
    with pytest.raises(sqlite3.ProgrammingError, match="Cannot operate on a closed database"):
        conn.execute("SELECT 1")


def test_connection_context_manager_closes_on_exception(
    database: SQLiteAdapter,
) -> None:
    captured_conn: sqlite3.Connection | None = None
    with pytest.raises(RuntimeError, match="simulated failure"):
        with database.connection() as conn:
            captured_conn = conn
            raise RuntimeError("simulated failure")

    assert captured_conn is not None
    with pytest.raises(sqlite3.ProgrammingError, match="Cannot operate on a closed database"):
        captured_conn.execute("SELECT 1")


def test_connect_memory_database(memory_database: SQLiteAdapter) -> None:
    conn = memory_database.connect()
    try:
        assert isinstance(conn, sqlite3.Connection)
        row = conn.execute("SELECT 42 AS value").fetchone()
        assert row["value"] == 42
    finally:
        conn.close()


def test_connect_nonexistent_database_fails(tmp_path: Path) -> None:
    nonexistent = tmp_path / "does_not_exist.sqlite"
    adapter = SQLiteAdapter(str(nonexistent))
    with pytest.raises(sqlite3.OperationalError, match="unable to open database file"):
        adapter.connect()


# -----------------------------------------------------------------------------
# Query Execution & Result Normalization Tests
# -----------------------------------------------------------------------------


def test_query_select_all(database: SQLiteAdapter) -> None:
    result = database.query("SELECT * FROM students ORDER BY id")
    assert isinstance(result, QueryResult)
    assert result.row_count == 8
    assert result.columns == ["id", "name", "gpa", "department_id"]
    assert len(result.rows) == 8

    # Verify dictionary mappings
    assert result.rows[0] == {
        "id": 1,
        "name": "Alice",
        "gpa": 9.2,
        "department_id": 1,
    }
    assert result.rows[-1] == {
        "id": 8,
        "name": "Hannah",
        "gpa": 8.1,
        "department_id": 3,
    }


def test_query_with_parameters(database: SQLiteAdapter) -> None:
    result = database.query(
        "SELECT name, gpa FROM students WHERE department_id = ? AND gpa > ? ORDER BY gpa DESC",
        [1, 9.0],
    )
    assert result.row_count == 2
    assert result.columns == ["name", "gpa"]
    assert result.rows == [
        {"name": "Diana", "gpa": 9.5},
        {"name": "Alice", "gpa": 9.2},
    ]


def test_query_empty_result(database: SQLiteAdapter) -> None:
    result = database.query(
        "SELECT * FROM students WHERE id = ?",
        [-999],
    )
    assert result.row_count == 0
    assert result.rows == []
    assert result.columns == ["id", "name", "gpa", "department_id"]


def test_query_with_join(database: SQLiteAdapter) -> None:
    sql = """
    SELECT s.name AS student_name, d.name AS department_name
    FROM students AS s
    JOIN departments AS d ON s.department_id = d.id
    WHERE s.id = 1
    """
    result = database.query(sql)
    assert result.row_count == 1
    assert result.rows[0] == {
        "student_name": "Alice",
        "department_name": "Computer Science",
    }


def test_query_with_cte(database: SQLiteAdapter) -> None:
    sql = """
    WITH cs_students AS (
        SELECT name, gpa FROM students WHERE department_id = 1
    )
    SELECT * FROM cs_students ORDER BY gpa DESC
    """
    result = database.query(sql)
    assert result.row_count == 4
    assert result.columns == ["name", "gpa"]
    assert result.rows[0]["name"] == "Diana"


def test_query_with_values(database: SQLiteAdapter) -> None:
    result = database.query("VALUES (1, 'alpha'), (2, 'beta')")
    assert result.row_count == 2
    assert len(result.columns) == 2
    first_col, second_col = result.columns
    assert result.rows[0][first_col] == 1
    assert result.rows[0][second_col] == "alpha"


def test_query_with_explain(database: SQLiteAdapter) -> None:
    result = database.query("EXPLAIN SELECT * FROM students")
    assert result.row_count > 0
    assert "opcode" in result.columns


def test_query_whitespace_and_newlines(database: SQLiteAdapter) -> None:
    result = database.query("  \n\t  SELECT COUNT(*) AS total FROM students")
    assert result.row_count == 1
    assert result.rows[0]["total"] == 8


def test_query_syntax_error_raises(database: SQLiteAdapter) -> None:
    with pytest.raises(sqlite3.OperationalError):
        database.query("SELECT * FROM non_existent_table")


# -----------------------------------------------------------------------------
# Preview Tests
# -----------------------------------------------------------------------------


def test_preview_default_limit(database: SQLiteAdapter) -> None:
    preview = database.preview("SELECT * FROM students")
    assert isinstance(preview, SqlPreview)
    assert preview.parameters == ()
    assert preview.result.row_count == 8
    assert "LIMIT 50" in preview.sql


def test_preview_custom_limit(database: SQLiteAdapter) -> None:
    preview = database.preview(
        "SELECT * FROM students ORDER BY id",
        limit=3,
    )
    assert preview.result.row_count == 3
    assert [row["id"] for row in preview.result.rows] == [1, 2, 3]
    assert "LIMIT 3" in preview.sql


def test_preview_with_parameters(database: SQLiteAdapter) -> None:
    preview = database.preview(
        "SELECT name FROM students WHERE department_id = ? ORDER BY id",
        parameters=[1],
        limit=2,
    )
    assert preview.parameters == (1,)
    assert preview.result.row_count == 2
    assert [row["name"] for row in preview.result.rows] == ["Alice", "Bob"]


def test_preview_strips_trailing_semicolons(database: SQLiteAdapter) -> None:
    preview = database.preview(
        "SELECT * FROM students;  ;\n",
        limit=2,
    )
    assert preview.result.row_count == 2


def test_preview_with_cte(database: SQLiteAdapter) -> None:
    sql = """
    WITH top_students AS (
        SELECT name, gpa FROM students ORDER BY gpa DESC
    )
    SELECT * FROM top_students
    """
    preview = database.preview(sql, limit=2)
    assert preview.result.row_count == 2
    assert preview.result.rows[0]["name"] == "Diana"
    assert preview.result.rows[1]["name"] == "Alice"


@pytest.mark.parametrize("invalid_limit", [0, -1, -50])
def test_preview_limit_non_positive_raises_value_error(
    database: SQLiteAdapter,
    invalid_limit: int,
) -> None:
    with pytest.raises(ValueError, match="limit must be greater than zero"):
        database.preview("SELECT 1", limit=invalid_limit)


@pytest.mark.parametrize("invalid_limit", ["10", 3.14, None, True, False, []])
def test_preview_limit_non_integer_raises_type_error(
    database: SQLiteAdapter,
    invalid_limit: Any,
) -> None:
    with pytest.raises(TypeError, match="limit must be an integer"):
        database.preview("SELECT 1", limit=invalid_limit)


@pytest.mark.parametrize("empty_sql", ["", "   ", "  ;  \n"])
def test_with_limit_empty_sql_raises(empty_sql: str) -> None:
    with pytest.raises(ValueError, match="sql cannot be empty"):
        SQLiteAdapter._with_limit(empty_sql, 10)


# -----------------------------------------------------------------------------
# Schema Inspection Tests
# -----------------------------------------------------------------------------


def test_table_names(database: SQLiteAdapter) -> None:
    names = database.table_names()
    assert names == ["courses", "departments", "students"]


@pytest.mark.parametrize(
    ("table_name", "expected"),
    [
        ("students", True),
        ("departments", True),
        ("courses", True),
        ("professors", False),
        ("nonexistent", False),
    ],
)
def test_table_exists(
    database: SQLiteAdapter,
    table_name: str,
    expected: bool,
) -> None:
    assert database.table_exists(table_name) is expected


def test_schema_table_students(database: SQLiteAdapter) -> None:
    table = database.schema_table("students")
    assert isinstance(table, TableSchema)
    assert table.name == "students"

    column_names = [col.name for col in table.columns]
    assert column_names == ["id", "name", "gpa", "department_id"]

    id_col = table.column("id")
    assert id_col is not None
    assert id_col.primary_key is True
    assert id_col.data_type == "INTEGER"

    name_col = table.column("name")
    assert name_col is not None
    assert name_col.nullable is False
    assert name_col.data_type == "TEXT"

    gpa_col = table.column("gpa")
    assert gpa_col is not None
    assert gpa_col.data_type == "REAL"
    assert gpa_col.nullable is True

    fk = table.foreign_key("department_id")
    assert fk is not None
    assert fk.referenced_table == "departments"
    assert fk.referenced_column == "id"


def test_schema_table_departments(database: SQLiteAdapter) -> None:
    table = database.schema_table("departments")
    assert table.name == "departments"
    assert table.has_column("name") is True
    assert table.has_column("nonexistent") is False

    # Check unique index on departments(name)
    assert len(table.indexes) == 1
    assert table.indexes[0].unique is True
    assert "name" in table.indexes[0].columns


def test_schema_table_nonexistent_raises(database: SQLiteAdapter) -> None:
    with pytest.raises(ValueError, match="Table does not exist: unknown_table"):
        database.schema_table("unknown_table")


def test_schema_full_database(database: SQLiteAdapter) -> None:
    schema = database.schema()
    assert isinstance(schema, DatabaseSchema)
    assert len(schema.tables) == 3

    assert schema.has_table("students") is True
    assert schema.has_table("departments") is True
    assert schema.has_table("courses") is True
    assert schema.has_table("unknown") is False

    # Column lookup via database schema
    gpa_col = schema.column("students", "gpa")
    assert gpa_col is not None
    assert gpa_col.data_type == "REAL"
    assert schema.column("unknown_table", "id") is None
    assert schema.column("students", "unknown_col") is None

    # Tables with specific column
    dept_fk_tables = schema.tables_with_column("department_id")
    dept_fk_names = sorted([t.name for t in dept_fk_tables])
    assert dept_fk_names == ["courses", "students"]

    # Relationships
    relationships = schema.relationships()
    assert len(relationships) == 2
    rel_sources = {source for source, _ in relationships}
    assert rel_sources == {"courses", "students"}
    for _, fk in relationships:
        assert fk.referenced_table == "departments"
        assert fk.referenced_column == "id"


# -----------------------------------------------------------------------------
# Immutability / Dataclass Contract Tests
# -----------------------------------------------------------------------------


def test_dataclasses_frozen(database: SQLiteAdapter) -> None:
    result = database.query("SELECT 1 AS num")
    with pytest.raises(dataclasses.FrozenInstanceError):
        result.row_count = 10  # type: ignore[misc]

    preview = database.preview("SELECT 1 AS num")
    with pytest.raises(dataclasses.FrozenInstanceError):
        preview.sql = "OTHER"  # type: ignore[misc]
