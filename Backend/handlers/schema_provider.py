from __future__ import annotations

from typing import Any
from db_adapters.schema import DatabaseSchema
from db_adapters.sqlite_adapter import SQLiteAdapter
from handlers.query_handler import SchemaProvider


class SQLiteSchemaProvider(SchemaProvider):
    """
    Supplies DatabaseSchema from SQLiteAdapter to QueryHandler.
    """

    def __init__(self, adapter: SQLiteAdapter):
        self.adapter = adapter
        self._cached_schema: DatabaseSchema | None = None

    def get_schema(self) -> DatabaseSchema:
        if self._cached_schema is None:
            self._cached_schema = self.adapter.schema()
        return self._cached_schema

    def refresh(self) -> DatabaseSchema:
        self._cached_schema = self.adapter.schema()
        return self._cached_schema
