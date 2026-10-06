from __future__ import annotations

import time
from typing import Any, Sequence
from db_adapters.sqlite_adapter import SQLiteAdapter
from handlers.query_handler import DatabaseAdapter, ExecutionResult


class SQLiteDatabaseAdapter(DatabaseAdapter):
    """
    Bridge between SQLiteAdapter and QueryHandler's DatabaseAdapter protocol.
    """

    def __init__(self, adapter: SQLiteAdapter):
        self.adapter = adapter

    def execute(
        self,
        sql: str,
        parameters: Sequence[Any] = (),
        *,
        max_rows: int | None = None,
    ) -> ExecutionResult:
        start_time = time.perf_counter()

        if max_rows is not None:
            preview = self.adapter.preview(
                sql,
                parameters,
                limit=max_rows,
            )
            elapsed_ms = (time.perf_counter() - start_time) * 1000.0
            return ExecutionResult(
                columns=tuple(preview.result.columns),
                rows=tuple(preview.result.rows),
                row_count=preview.result.row_count,
                execution_time_ms=elapsed_ms,
            )
        else:
            res = self.adapter.query(
                sql,
                parameters,
            )
            elapsed_ms = (time.perf_counter() - start_time) * 1000.0
            return ExecutionResult(
                columns=tuple(res.columns),
                rows=tuple(res.rows),
                row_count=res.row_count,
                execution_time_ms=elapsed_ms,
            )
