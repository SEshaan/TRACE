from __future__ import annotations

from typing import Any
from handlers.query_handler import QueryState, SQLCompiler


class SQLiteCompiler(SQLCompiler):
    """
    Compiles a sequence of validated QueryActions into parameterized SQLite SQL.
    """

    def compile(
        self,
        *,
        state: QueryState,
    ) -> tuple[str, tuple[Any, ...]]:
        if not state.actions:
            raise ValueError("Cannot compile query with no actions.")

        base_table: str | None = None
        columns: list[str] = []
        aggregates: list[str] = []
        joins: list[tuple[str, str, str, str]] = []  # (join_type, table, left_on, right_on)
        filters: list[tuple[str, str, Any, str | None]] = []  # (col, op, val, table)
        group_by: list[str] = []
        order_by: list[tuple[str, str, str | None, str | None]] = []
        limit: int | None = None

        for action in state.actions:
            atype = getattr(action, "action_type", None)

            if atype == "SELECT_TABLE":
                base_table = getattr(action, "table")

            elif atype == "SELECT_COLUMN":
                col = getattr(action, "column")
                tbl = getattr(action, "table", None)
                alias = getattr(action, "alias", None)
                
                col_ref = f"{self._quote_id(tbl)}.{self._quote_id(col)}" if tbl else self._quote_id(col)
                if alias:
                    col_ref = f"{col_ref} AS {self._quote_id(alias)}"
                columns.append(col_ref)

            elif atype == "JOIN":
                joins.append((
                    getattr(action, "join_type", "INNER"),
                    getattr(action, "table"),
                    getattr(action, "left_on"),
                    getattr(action, "right_on"),
                ))

            elif atype == "FILTER":
                filters.append((
                    getattr(action, "column"),
                    getattr(action, "operator"),
                    getattr(action, "value"),
                    getattr(action, "table", None),
                ))

            elif atype == "GROUP_BY":
                col = getattr(action, "column")
                tbl = getattr(action, "table", None)
                col_ref = f"{self._quote_id(tbl)}.{self._quote_id(col)}" if tbl else self._quote_id(col)
                group_by.append(col_ref)

            elif atype == "AGGREGATE":
                function = getattr(action, "function").upper()
                if function not in {"COUNT", "SUM", "AVG", "MIN", "MAX"}:
                    raise ValueError(f"Unsupported aggregate function: {function}")
                col = getattr(action, "column")
                tbl = getattr(action, "table", None)
                col_ref = (
                    f"{self._quote_id(tbl)}.{self._quote_id(col)}"
                    if tbl and col != "*"
                    else self._quote_id(col)
                )
                expression = f"{function}({col_ref})"
                alias = getattr(action, "alias", None)
                if alias:
                    expression += f" AS {self._quote_id(alias)}"
                aggregates.append(expression)

            elif atype == "ORDER_BY":
                order_by.append((
                    getattr(action, "column"),
                    getattr(action, "direction", "ASC"),
                    getattr(action, "table", None),
                    getattr(action, "aggregate_function", None),
                ))

            elif atype == "LIMIT":
                limit = getattr(action, "limit")

            elif atype == "FINISH":
                pass

        if not base_table:
            raise ValueError("Cannot compile query without a SELECT_TABLE action.")

        # SELECT clause
        select_items = [*columns, *aggregates]
        select_clause = ", ".join(select_items) if select_items else "*"

        # FROM clause
        from_clause = self._quote_id(base_table)

        # JOIN clauses
        join_clauses = []
        for j_type, j_table, left_on, right_on in joins:
            left_ref = self._format_col_ref(left_on, base_table)
            right_ref = f"{self._quote_id(j_table)}.{self._quote_id(right_on)}"
            join_clauses.append(
                f"{j_type} JOIN {self._quote_id(j_table)} ON {left_ref} = {right_ref}"
            )

        # WHERE clause & parameters
        where_clauses = []
        parameters: list[Any] = []
        for col, op, val, tbl in filters:
            col_ref = f"{self._quote_id(tbl)}.{self._quote_id(col)}" if tbl else self._quote_id(col)
            op_upper = op.upper()
            if op_upper in ("IS NULL", "IS NOT NULL"):
                where_clauses.append(f"{col_ref} {op_upper}")
            elif op_upper == "IN":
                val_list = list(val) if isinstance(val, (list, tuple, set)) else [val]
                placeholders = ", ".join(["?"] * len(val_list))
                where_clauses.append(f"{col_ref} IN ({placeholders})")
                parameters.extend(val_list)
            else:
                where_clauses.append(f"{col_ref} {op_upper} ?")
                parameters.append(val)

        # Build SQL
        sql_parts = [f"SELECT {select_clause} FROM {from_clause}"]
        if join_clauses:
            sql_parts.extend(join_clauses)
        if where_clauses:
            sql_parts.append(f"WHERE {' AND '.join(where_clauses)}")
        if group_by:
            sql_parts.append(f"GROUP BY {', '.join(group_by)}")
        if order_by:
            order_clauses = [
                (
                    f"{function.upper()}("
                    f"{self._quote_id(table) + '.' if table else ''}{self._quote_id(column)}"
                    f") {direction.upper()}"
                    if function
                    else (
                        f"{self._quote_id(table) + '.' if table else ''}"
                        f"{self._quote_id(column)} {direction.upper()}"
                    )
                )
                for column, direction, table, function in order_by
            ]
            sql_parts.append(f"ORDER BY {', '.join(order_clauses)}")
        if limit is not None:
            sql_parts.append(f"LIMIT {limit}")

        return "\n".join(sql_parts), tuple(parameters)

    @staticmethod
    def _quote_id(identifier: str) -> str:
        if identifier == "*":
            return "*"
        return f'"{identifier.replace(chr(34), chr(34)+chr(34))}"'

    def _format_col_ref(self, col: str, default_table: str) -> str:
        if "." in col:
            parts = col.split(".", 1)
            return f"{self._quote_id(parts[0])}.{self._quote_id(parts[1])}"
        return f"{self._quote_id(default_table)}.{self._quote_id(col)}"
