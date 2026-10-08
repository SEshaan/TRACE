from __future__ import annotations

from db_adapters.schema import DatabaseSchema
from db_adapters.sqlite_adapter import SQLiteAdapter
from handlers.query_handler import SchemaProvider


class SQLiteSchemaProvider(SchemaProvider):
    """
    Supplies DatabaseSchema from SQLiteAdapter to QueryHandler.
    """

    def __init__(self, adapter: SQLiteAdapter):
        self.adapter = adapter

    def get_schema(self) -> DatabaseSchema:
        return self.adapter.schema()

    def refresh(self) -> DatabaseSchema:
        return self.get_schema()
