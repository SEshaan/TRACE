from __future__ import annotations

import re
from typing import Any, Sequence


_SAFE_IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_SQL_KEYWORDS = frozenset(
    """
    ABORT ACTION ADD AFTER ALL ALTER ANALYZE AND AS ASC ATTACH AUTOINCREMENT
    BEFORE BEGIN BETWEEN BY CASCADE CASE CAST CHECK COLLATE COLUMN COMMIT
    CONFLICT CONSTRAINT CREATE CROSS CURRENT CURRENT_DATE CURRENT_TIME CURRENT_TIMESTAMP
    DATABASE DEFAULT DEFERRABLE DEFERRED DELETE DESC DETACH DISTINCT DROP EACH
    DO ELSE END ESCAPE EXCEPT EXCLUDE EXCLUSIVE EXISTS EXPLAIN FAIL FILTER FIRST
    FOLLOWING FOR FOREIGN FROM FULL GENERATED GLOB GROUP GROUPS HAVING IF
    IGNORE IMMEDIATE IN INDEX
    INDEXED INITIALLY INNER INSERT INSTEAD INTERSECT INTO IS ISNULL JOIN KEY
    LAST LEFT LIKE LIMIT MATCH MATERIALIZED NATURAL NO NOT NOTHING NOTNULL
    NULL NULLS OF OFFSET OLD ON OR ORDER OTHERS OUTER OVER PARTITION PLAN PRAGMA
    PRECEDING PRIMARY QUERY RAISE RANGE RECURSIVE REFERENCES REGEXP REINDEX
    RELEASE RENAME REPLACE RESTRICT RETURNING RIGHT ROLLBACK ROW ROWS SAVEPOINT
    SELECT SET STORED STRICT TABLE TEMP TEMPORARY THEN TIES TO TRANSACTION
    TRIGGER UNBOUNDED UNION UNIQUE UPDATE USING VACUUM VALUES VIEW VIRTUAL WHEN
    WHERE WINDOW WITH WITHOUT
    """.split()
)


def _display_literal(value: Any) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, (int, float)):
        return repr(value)
    if isinstance(value, str):
        return "'" + value.replace("'", "''") + "'"
    if isinstance(value, bytes):
        return "X'" + value.hex() + "'"
    raise TypeError(f"Cannot render SQL parameter of type {type(value).__name__}")


def format_sql_for_display(sql: str, parameters: Sequence[Any]) -> str:
    """Render compiler SQL with bound literals for display, never execution."""
    rendered: list[str] = []
    parameter_index = 0
    index = 0

    while index < len(sql):
        char = sql[index]

        if char == '"':
            end = index + 1
            identifier_chars: list[str] = []
            while end < len(sql):
                if sql[end] == '"':
                    if end + 1 < len(sql) and sql[end + 1] == '"':
                        identifier_chars.append('"')
                        end += 2
                        continue
                    break
                identifier_chars.append(sql[end])
                end += 1

            if end == len(sql):
                raise ValueError("Unterminated quoted SQL identifier")

            identifier = "".join(identifier_chars)
            if (
                _SAFE_IDENTIFIER.fullmatch(identifier)
                and identifier.upper() not in _SQL_KEYWORDS
            ):
                rendered.append(identifier)
            else:
                rendered.append('"' + identifier.replace('"', '""') + '"')
            index = end + 1
            continue

        if char == "'":
            end = index + 1
            while end < len(sql):
                if sql[end] == "'":
                    if end + 1 < len(sql) and sql[end + 1] == "'":
                        end += 2
                        continue
                    break
                end += 1
            if end == len(sql):
                raise ValueError("Unterminated SQL string literal")
            rendered.append(sql[index : end + 1])
            index = end + 1
            continue

        if char == "?":
            if parameter_index >= len(parameters):
                raise ValueError("SQL has more placeholders than bound parameters")
            rendered.append(_display_literal(parameters[parameter_index]))
            parameter_index += 1
        else:
            rendered.append(char)
        index += 1

    if parameter_index != len(parameters):
        raise ValueError("SQL has fewer placeholders than bound parameters")

    return "".join(rendered)
