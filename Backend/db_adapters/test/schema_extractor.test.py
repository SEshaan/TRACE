"""Dedicated SchemaExtractor coverage.

The extractor reads SQLite's schema (sqlite_master + PRAGMA views) and maps it
onto the platform's deterministic schema representation. These tests build an
in-memory database from a small DDL script so they assert on real PRAGMA output
without depending on any committed fixture binary.
"""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

_TEST_DIR = Path(__file__).resolve().parent
_WORKSPACE_ROOT = _TEST_DIR.parents[2]
if str(_WORKSPACE_ROOT) not in sys.path:
    sys.path.insert(0, str(_WORKSPACE_ROOT))

import pytest

from Backend.db_adapters.schema import SchemaExtractor

DDL = """
CREATE TABLE departments (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    building TEXT
);

CREATE TABLE students (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    department_id INTEGER REFERENCES departments(id),
    gpa REAL,
    UNIQUE(name)
);

CREATE INDEX idx_students_gpa ON students(gpa);
"""


@pytest.fixture
def extractor():
    conn = sqlite3.connect(":memory:")
    conn.executescript(DDL)
    yield SchemaExtractor(conn)
    conn.close()


def test_tables_extracted_in_order(extractor: SchemaExtractor):
    schema = extractor.extract()

    names = [table.name for table in schema.tables]
    assert names == ["departments", "students"]  # ORDER BY name

    assert schema.has_table("departments")
    assert schema.has_table("students")
    assert not schema.has_table("ghost")


def test_column_metadata(extractor: SchemaExtractor):
    departments = extractor.extract().table("departments")

    id_col = departments.column("id")
    assert id_col is not None
    assert id_col.name == "id"
    assert id_col.data_type == "INTEGER"
    assert id_col.primary_key is True
    # schema.py maps primary_key_position from PRAGMA table_info's pk flag,
    # so a primary-key column reports 1 (existing adapter behavior).
    assert id_col.primary_key_position == 1

    name_col = departments.column("name")
    assert name_col is not None
    assert name_col.nullable is False  # NOT NULL
    assert name_col.data_type == "TEXT"

    building_col = departments.column("building")
    assert building_col is not None
    assert building_col.nullable is True


def test_primary_key_position_tracking(extractor: SchemaExtractor):
    students = extractor.extract().table("students")

    id_col = students.column("id")
    assert id_col.primary_key is True
    # schema.py maps primary_key_position from PRAGMA table_info's pk flag,
    # so a primary-key column reports 1 (existing adapter behavior).
    assert id_col.primary_key_position == 1


def test_foreign_keys(extractor: SchemaExtractor):
    students = extractor.extract().table("students")

    fk = students.foreign_key("department_id")
    assert fk is not None
    assert fk.referenced_table == "departments"
    assert fk.referenced_column == "id"
    assert fk.column == "department_id"

    # departments declares no foreign keys.
    assert extractor.extract().table("departments").foreign_keys == []


def test_indexes(extractor: SchemaExtractor):
    students = extractor.extract().table("students")

    indexes = {index.name: index for index in students.indexes}
    assert "idx_students_gpa" in indexes
    index = indexes["idx_students_gpa"]
    assert index.unique is False
    assert index.columns == ["gpa"]


def test_relationships(extractor: SchemaExtractor):
    relationships = extractor.extract().relationships()

    # Only one relationship exists (students -> departments).
    assert len(relationships) == 1
    source_table, foreign_key = relationships[0]
    assert source_table == "students"
    assert foreign_key.referenced_table == "departments"


def test_tables_with_column(extractor: SchemaExtractor):
    schema = extractor.extract()

    # gpa only exists on students.
    tables_with_gpa = [table.name for table in schema.tables_with_column("gpa")]
    assert tables_with_gpa == ["students"]


def test_extract_table_missing_raises(extractor: SchemaExtractor):
    with pytest.raises(ValueError, match="does not exist"):
        extractor.extract_table("no_such_table")
