from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class ColumnSchema:
    """
    A database column exposed to the query action system.
    """

    name: str
    data_type: str

    nullable: bool = True
    default: Any = None

    primary_key: bool = False
    primary_key_position: int = 0

    generated: bool = False


@dataclass(frozen=True)
class ForeignKeySchema:
    """
    A relationship from one table column to another.
    """

    column: str

    referenced_table: str
    referenced_column: str

    on_update: str = "NO ACTION"
    on_delete: str = "NO ACTION"


@dataclass(frozen=True)
class IndexSchema:
    """
    Index metadata.

    Primarily useful for schema inspection and future query-planning
    features. It is not part of the action space.
    """

    name: str
    unique: bool

    columns: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class TableSchema:
    """
    Schema information for a single database table.
    """

    name: str

    columns: list[ColumnSchema] = field(
        default_factory=list,
    )

    foreign_keys: list[ForeignKeySchema] = field(
        default_factory=list,
    )

    indexes: list[IndexSchema] = field(
        default_factory=list,
    )

    def column(
        self,
        name: str,
    ) -> ColumnSchema | None:
        return next(
            (
                column
                for column in self.columns
                if column.name == name
            ),
            None,
        )

    def has_column(
        self,
        name: str,
    ) -> bool:
        return self.column(name) is not None

    def foreign_key(
        self,
        column: str,
    ) -> ForeignKeySchema | None:
        return next(
            (
                foreign_key
                for foreign_key in self.foreign_keys
                if foreign_key.column == column
            ),
            None,
        )


@dataclass(frozen=True)
class DatabaseSchema:
    """
    Complete schema visible to the query agent.

    This object is the environment's authoritative description of
    what tables, columns, and relationships are available.
    """

    tables: list[TableSchema] = field(
        default_factory=list,
    )

    def table(
        self,
        name: str,
    ) -> TableSchema | None:
        return next(
            (
                table
                for table in self.tables
                if table.name == name
            ),
            None,
        )

    def has_table(
        self,
        name: str,
    ) -> bool:
        return self.table(name) is not None

    def column(
        self,
        table_name: str,
        column_name: str,
    ) -> ColumnSchema | None:
        table = self.table(table_name)

        if table is None:
            return None

        return table.column(column_name)

    def tables_with_column(
        self,
        column_name: str,
    ) -> list[TableSchema]:
        return [
            table
            for table in self.tables
            if table.has_column(column_name)
        ]

    def relationships(
        self,
    ) -> list[tuple[str, ForeignKeySchema]]:
        """
        Return all foreign-key relationships as:

            (source_table, foreign_key)
        """
        return [
            (table.name, foreign_key)
            for table in self.tables
            for foreign_key in table.foreign_keys
        ]


class SchemaExtractor:
    """
    Extracts SQLite's schema into the platform's deterministic schema
    representation.
    """

    def __init__(
        self,
        connection: sqlite3.Connection,
    ):
        self.connection = connection

    def extract(self) -> DatabaseSchema:
        tables = [
            self._extract_table(table_name)
            for table_name in self._get_tables()
        ]

        return DatabaseSchema(
            tables=tables,
        )

    def extract_table(
        self,
        table_name: str,
    ) -> TableSchema:
        if table_name not in self._get_tables():
            raise ValueError(
                f"Table does not exist: {table_name}"
            )

        return self._extract_table(table_name)

    def _get_tables(self) -> list[str]:
        rows = self.connection.execute(
            """
            SELECT name
            FROM sqlite_master
            WHERE type = 'table'
              AND name NOT LIKE 'sqlite_%'
            ORDER BY name
            """
        ).fetchall()

        return [
            row[0]
            for row in rows
        ]

    def _extract_table(
        self,
        table_name: str,
    ) -> TableSchema:
        return TableSchema(
            name=table_name,
            columns=self._extract_columns(
                table_name,
            ),
            foreign_keys=self._extract_foreign_keys(
                table_name,
            ),
            indexes=self._extract_indexes(
                table_name,
            ),
        )

    def _extract_columns(
        self,
        table_name: str,
    ) -> list[ColumnSchema]:
        rows = self.connection.execute(
            f"""
            PRAGMA table_info(
                {self._quote_identifier(table_name)}
            )
            """
        ).fetchall()

        return [
            ColumnSchema(
                name=row[1],
                data_type=row[2],
                nullable=not bool(row[3]),
                default=row[4],
                primary_key=bool(row[5]),
                primary_key_position=row[5],
            )
            for row in rows
        ]

    def _extract_foreign_keys(
        self,
        table_name: str,
    ) -> list[ForeignKeySchema]:
        rows = self.connection.execute(
            f"""
            PRAGMA foreign_key_list(
                {self._quote_identifier(table_name)}
            )
            """
        ).fetchall()

        return [
            ForeignKeySchema(
                column=row[3],
                referenced_table=row[2],
                referenced_column=row[4],
                on_update=row[5],
                on_delete=row[6],
            )
            for row in rows
        ]

    def _extract_indexes(
        self,
        table_name: str,
    ) -> list[IndexSchema]:
        rows = self.connection.execute(
            f"""
            PRAGMA index_list(
                {self._quote_identifier(table_name)}
            )
            """
        ).fetchall()

        indexes = []

        for row in rows:
            index_name = row[1]
            unique = bool(row[2])

            index_columns = self.connection.execute(
                f"""
                PRAGMA index_info(
                    {self._quote_identifier(index_name)}
                )
                """
            ).fetchall()

            columns = [
                index_column[2]
                for index_column in index_columns
                if index_column[2] is not None
            ]

            indexes.append(
                IndexSchema(
                    name=index_name,
                    unique=unique,
                    columns=columns,
                )
            )

        return indexes

    @staticmethod
    def _quote_identifier(
        identifier: str,
    ) -> str:
        return (
            '"'
            + identifier.replace('"', '""')
            + '"'
        )
