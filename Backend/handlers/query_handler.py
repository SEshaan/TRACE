from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass
class Query:
    """
    Represents a single query session.

    Query does not know how the database works. Database-specific
    behavior belongs to the adapter.

    The adapter is expected to provide:
        - schema()
        - execute()
        - transaction handling
        - connection lifecycle
    """

    query_id: str
    database: Any | None = None
    schema: Any | None = None

    def connect(self, database: Any) -> None:
        """
        Attach a database adapter and cache its schema.

        No database-specific logic belongs here.
        """
        self.database = database
        self.schema = database.schema()

    def disconnect(self) -> None:
        """
        Detach the database adapter.

        The adapter owns its own connection lifecycle.
        """
        self.database = None
        self.schema = None

    @property
    def connected(self) -> bool:
        return self.database is not None
