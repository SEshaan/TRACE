from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any, Iterator, Sequence

from .schema import (
    DatabaseSchema,
    SchemaExtractor,
    TableSchema,
)


@dataclass(frozen=True)
class QueryResult:
    columns: list[str]
    rows: list[dict[str, Any]]
    row_count: int


@dataclass(frozen=True)
class SqlPreview:
    sql: str
    parameters: tuple[Any, ...]
    result: QueryResult


class SQLiteAdapter:
    """
    Read-only SQLite adapter.

    The query execution platform currently supports only read operations.

    Responsibilities:
      - open SQLite connections
      - inspect schema
      - execute read-only SQL
      - execute bounded previews
      - expose normalized results

    This adapter does NOT:
      - generate SQL
      - validate query actions
      - interpret natural language
      - mutate the database
      - manage application/query-state persistence
    """

    def __init__(
        self,
        database_path: str,
        *,
        timeout: float = 5.0,
    ):
        self.database_path = database_path
        self.timeout = timeout

    def connect(self) -> sqlite3.Connection:
        """
        Open a read-only SQLite connection.

        SQLite's mode=ro prevents writes at the connection level.
        """
        if self.database_path == ":memory:":
            connection = sqlite3.connect(
                self.database_path,
                timeout=self.timeout,
            )
        else:
            connection = sqlite3.connect(
                f"file:{self.database_path}?mode=ro",
                uri=True,
                timeout=self.timeout,
            )

        connection.row_factory = sqlite3.Row

        # Enforce FK semantics when joins/schema relationships are inspected.
        connection.execute("PRAGMA foreign_keys = ON")

        return connection

    @contextmanager
    def connection(self) -> Iterator[sqlite3.Connection]:
        """
        Provide a read-only connection.

        No commit/rollback is performed because the adapter does not
        support mutations.
        """
        connection = self.connect()

        try:
            yield connection
        finally:
            connection.close()

    def query(
        self,
        sql: str,
        parameters: Sequence[Any] = (),
    ) -> QueryResult:
        """
        Execute a read-only SQL query.

        Intended for:
          - compiled query execution
          - final result retrieval
          - intermediate state execution

        No LIMIT is automatically added.

        Use preview() when an execution must be bounded.
        """
        self._validate_read_only_sql(sql)

        with self.connection() as connection:
            cursor = connection.execute(
                sql,
                tuple(parameters),
            )

            rows = cursor.fetchall()

            columns = [
                description[0]
                for description in cursor.description or []
            ]

        normalized_rows = [
            {
                column: row[column]
                for column in columns
            }
            for row in rows
        ]

        return QueryResult(
            columns=columns,
            rows=normalized_rows,
            row_count=len(normalized_rows),
        )

    def preview(
        self,
        sql: str,
        parameters: Sequence[Any] = (),
        *,
        limit: int = 50,
    ) -> SqlPreview:
        """
        Execute a bounded read-only preview.

        The preview always gets an explicit outer LIMIT.
        """
        self._validate_limit(limit)
        self._validate_read_only_sql(sql)

        preview_sql = self._with_limit(
            sql,
            limit,
        )

        result = self.query(
            preview_sql,
            parameters,
        )

        return SqlPreview(
            sql=preview_sql,
            parameters=tuple(parameters),
            result=result,
        )

    def schema(self) -> DatabaseSchema:
        """
        Extract the complete database schema.
        """
        with self.connection() as connection:
            return SchemaExtractor(connection).extract()

    def schema_table(
        self,
        table_name: str,
    ) -> TableSchema:
        """
        Extract one table's schema.
        """
        with self.connection() as connection:
            return SchemaExtractor(connection).extract_table(
                table_name,
            )

    def table_exists(
        self,
        table_name: str,
    ) -> bool:
        """
        Check whether a user table exists.
        """
        result = self.query(
            """
            SELECT 1
            FROM sqlite_master
            WHERE type = 'table'
              AND name = ?
            LIMIT 1
            """,
            [table_name],
        )

        return result.row_count == 1

    def table_names(self) -> list[str]:
        """
        Return user-created tables.
        """
        result = self.query(
            """
            SELECT name
            FROM sqlite_master
            WHERE type = 'table'
              AND name NOT LIKE 'sqlite_%'
            ORDER BY name
            """
        )

        return [
            row["name"]
            for row in result.rows
        ]

    @staticmethod
    def _validate_limit(limit: int) -> None:
        if isinstance(limit, bool) or not isinstance(limit, int):
            raise TypeError("limit must be an integer")

        if limit <= 0:
            raise ValueError(
                "limit must be greater than zero"
            )

    @staticmethod
    def _validate_read_only_sql(sql: str) -> None:
        """
        Lightweight guard against accidental mutation.

        The action validator/compiler is responsible for determining
        whether the generated SQL is semantically legal.

        This adapter only enforces the read-only contract.
        """
        normalized = sql.lstrip().upper()

        allowed = (
            normalized.startswith("SELECT"),
            normalized.startswith("WITH"),
            normalized.startswith("VALUES"),
            normalized.startswith("EXPLAIN"),
        )

        if not any(allowed):
            raise ValueError(
                "SQLite adapter only supports read-only SQL"
            )

    @classmethod
    def _with_limit(
        cls,
        sql: str,
        limit: int,
    ) -> str:
        """
        Bound arbitrary read-only query SQL without modifying its
        internal structure.
        """
        sql = sql.rstrip("; \t\r\n").strip()

        if not sql:
            raise ValueError("sql cannot be empty")

        return (
            "SELECT *\n"
            "FROM (\n"
            f"{sql}\n"
            ") AS __preview\n"
            f"LIMIT {limit}"
        )
