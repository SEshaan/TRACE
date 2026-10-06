from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field
from typing import Any


@dataclass
class ColumnSchema:
    name: str
    data_type: str
    nullable: bool
    default: Any
    primary_key: bool
    primary_key_position: int
    generated: bool = False


@dataclass
class ForeignKeySchema:
    column: str
    referenced_table: str
    referenced_column: str
    on_update: str
    on_delete: str


@dataclass
class IndexSchema:
    name: str
    unique: bool
    columns: list[str]


@dataclass
class TableSchema:
    name: str
    columns: list[ColumnSchema] = field(default_factory=list)
    foreign_keys: list[ForeignKeySchema] = field(default_factory=list)
    indexes: list[IndexSchema] = field(default_factory=list)


@dataclass
class DatabaseSchema:
    tables: list[TableSchema] = field(default_factory=list)

    def table(self, name: str) -> TableSchema | None:
        return next(
            (table for table in self.tables if table.name == name),
            None,
        )


class SchemaExtractor:
    """
    Extracts a SQLite database schema into a deterministic Python model.

    The extracted schema is intended to be consumed by:
      - the query decision model
      - action validation
      - SQL compilation
      - frontend schema exploration
    """

    def __init__(self, connection: sqlite3.Connection):
        self.connection = connection

    def extract(self) -> DatabaseSchema:
        tables = []

        for table_name in self._get_tables():
            tables.append(self._extract_table(table_name))

        return DatabaseSchema(tables=tables)

    def extract_table(self, table_name: str) -> TableSchema:
        """
        Extract a single table.

        Raises:
            ValueError: if the table does not exist.
        """
        if table_name not in self._get_tables():
            raise ValueError(f"Table does not exist: {table_name}")

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

        return [row[0] for row in rows]

    def _extract_table(self, table_name: str) -> TableSchema:
        columns = self._extract_columns(table_name)
        foreign_keys = self._extract_foreign_keys(table_name)
        indexes = self._extract_indexes(table_name)

        return TableSchema(
            name=table_name,
            columns=columns,
            foreign_keys=foreign_keys,
            indexes=indexes,
        )

    def _extract_columns(self, table_name: str) -> list[ColumnSchema]:
        rows = self.connection.execute(
            f"PRAGMA table_info({self._quote_identifier(table_name)})"
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
            f"PRAGMA foreign_key_list({self._quote_identifier(table_name)})"
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
        index_rows = self.connection.execute(
            f"PRAGMA index_list({self._quote_identifier(table_name)})"
        ).fetchall()

        indexes = []

        for row in index_rows:
            index_name = row[1]
            unique = bool(row[2])

            column_rows = self.connection.execute(
                f"PRAGMA index_info({self._quote_identifier(index_name)})"
            ).fetchall()

            columns = [
                column_row[2]
                for column_row in column_rows
                if column_row[2] is not None
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
    def _quote_identifier(identifier: str) -> str:
        """
        Safely quote a SQLite identifier.

        Identifiers cannot be parameterized using ? placeholders,
        so we escape embedded double quotes.
        """
        return '"' + identifier.replace('"', '""') + '"'


def extract_schema(
    database_path: str,
) -> DatabaseSchema:
    """
    Convenience function for extracting an entire SQLite database.
    """
    connection = sqlite3.connect(database_path)

    try:
        extractor = SchemaExtractor(connection)
        return extractor.extract()
    finally:
        connection.close()


if __name__ == "__main__":
    schema = extract_schema("./test/test.sqlite")

    for table in schema.tables:
        print(table.name)

        for column in table.columns:
            print(
                column.name,
                column.data_type,
                column.nullable,
                column.primary_key,
            )

        for fk in table.foreign_keys:
            print(
                fk.column,
                "->",
                f"{fk.referenced_table}.{fk.referenced_column}",
            )
