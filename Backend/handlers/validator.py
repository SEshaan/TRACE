from __future__ import annotations

from typing import Any
from handlers.actions import (
    AbortQueryAction,
    FilterAction,
    GroupByAction,
    InsufficientInfoAction,
    JoinAction,
    LimitAction,
    OrderByAction,
    SchemaMissingAction,
    SelectColumnAction,
    SelectTableAction,
)
from handlers.query_handler import QueryAction, QueryState, Validator


class DeterministicValidator(Validator):
    """
    Validates actions deterministically according to MVP rules and schema.
    No LLM calls or fuzzy reasoning happen here.
    """

    ALLOWED_OPERATORS = {
        "=", "!=", ">", ">=", "<", "<=", "LIKE", "IN", "IS NULL", "IS NOT NULL"
    }
    ALLOWED_JOIN_TYPES = {"INNER", "LEFT", "RIGHT"}
    ALLOWED_ORDER_DIRECTIONS = {"ASC", "DESC"}
    ALLOWED_AGGREGATES = {"COUNT", "SUM", "AVG", "MIN", "MAX"}

    def validate(
        self,
        *,
        action: QueryAction,
        state: QueryState,
        environment: Any,
    ) -> None:
        action_type = getattr(action, "action_type", None)
        if not action_type:
            raise ValueError("Action missing action_type.")

        # Dispatch based on action_type
        if action_type == "SELECT_TABLE":
            self._validate_select_table(action, state, environment)
        elif action_type == "SELECT_COLUMN":
            self._validate_select_column(action, state, environment)
        elif action_type == "FILTER":
            self._validate_filter(action, state, environment)
        elif action_type == "JOIN":
            self._validate_join(action, state, environment)
        elif action_type == "GROUP_BY":
            self._validate_group_by(action, state, environment)
        elif action_type == "AGGREGATE":
            self._validate_aggregate(action, state, environment)
        elif action_type == "ORDER_BY":
            self._validate_order_by(action, state, environment)
        elif action_type == "LIMIT":
            self._validate_limit(action, state, environment)
        elif action_type == "FINISH":
            self._validate_finish(action, state, environment)
        elif action_type == "INSUFFICIENT_INFO":
            self._validate_insufficient_info(action, state, environment)
        elif action_type == "SCHEMA_MISSING":
            self._validate_schema_missing(action, state, environment)
        elif action_type == "ABORT_QUERY":
            self._validate_abort_query(action, state, environment)
        else:
            raise ValueError(f"Unknown action type: {action_type}")

    def _get_active_tables(self, state: QueryState) -> list[str]:
        tables: list[str] = []
        for act in state.actions:
            if getattr(act, "action_type", None) == "SELECT_TABLE":
                tables.append(getattr(act, "table"))
            elif getattr(act, "action_type", None) == "JOIN":
                tables.append(getattr(act, "table"))
        return tables

    def _resolve_column(self, col: str, table: str | None, active_tables: list[str], schema: Any) -> bool:
        if col == "*":
            return True
        if schema is None:
            return True

        if table:
            t = schema.table(table)
            return t is not None and t.has_column(col)

        # Check across all active tables
        for t_name in active_tables:
            t = schema.table(t_name)
            if t and t.has_column(col):
                return True
        return False

    def _validate_select_table(self, action: Any, state: QueryState, schema: Any) -> None:
        table_name = getattr(action, "table", None)
        if not table_name:
            raise ValueError("SELECT_TABLE requires a table name.")
        active = self._get_active_tables(state)
        if active:
            raise ValueError(f"Base table already selected: {active[0]}. Use JOIN to add tables.")
        if schema and not schema.has_table(table_name):
            raise ValueError(f"Table '{table_name}' does not exist in schema.")

    def _validate_select_column(self, action: Any, state: QueryState, schema: Any) -> None:
        active = self._get_active_tables(state)
        if not active:
            raise ValueError("Cannot select columns before selecting a table.")
        col = getattr(action, "column", None)
        if not col:
            raise ValueError("SELECT_COLUMN requires a column name.")
        table = getattr(action, "table", None)
        if not self._resolve_column(col, table, active, schema):
            raise ValueError(f"Column '{col}' not found in active tables: {active}.")

    def _validate_filter(self, action: Any, state: QueryState, schema: Any) -> None:
        active = self._get_active_tables(state)
        if not active:
            raise ValueError("Cannot filter before selecting a table.")
        col = getattr(action, "column", None)
        if not col:
            raise ValueError("FILTER requires a column name.")
        op = getattr(action, "operator", None)
        if not op or op.upper() not in self.ALLOWED_OPERATORS:
            raise ValueError(f"Invalid filter operator '{op}'. Allowed: {self.ALLOWED_OPERATORS}")
        table = getattr(action, "table", None)
        if not self._resolve_column(col, table, active, schema):
            raise ValueError(f"Column '{col}' not found in active tables: {active}.")

    def _validate_join(self, action: Any, state: QueryState, schema: Any) -> None:
        active = self._get_active_tables(state)
        if not active:
            raise ValueError("Cannot join before selecting a base table.")
        target_table = getattr(action, "table", None)
        if not target_table:
            raise ValueError("JOIN requires a target table name.")
        if target_table in active:
            raise ValueError(f"Table '{target_table}' is already joined.")
        if schema and not schema.has_table(target_table):
            raise ValueError(f"Table '{target_table}' does not exist in schema.")
        
        left_on = getattr(action, "left_on", None)
        right_on = getattr(action, "right_on", None)
        if not left_on or not right_on:
            raise ValueError("JOIN requires left_on and right_on join keys.")
        
        # Validate left_on in existing active tables
        if not self._resolve_column(left_on, None, active, schema):
            raise ValueError(f"Left join key '{left_on}' not found in active tables: {active}.")
        # Validate right_on in target table
        if schema and not self._resolve_column(right_on, target_table, [target_table], schema):
            raise ValueError(f"Right join key '{right_on}' not found in table '{target_table}'.")

    def _validate_group_by(self, action: Any, state: QueryState, schema: Any) -> None:
        active = self._get_active_tables(state)
        if not active:
            raise ValueError("Cannot group by before selecting a table.")
        col = getattr(action, "column", None)
        if not col:
            raise ValueError("GROUP_BY requires a column name.")
        table = getattr(action, "table", None)
        if not self._resolve_column(col, table, active, schema):
            raise ValueError(f"Column '{col}' not found in active tables: {active}.")

    def _validate_aggregate(self, action: Any, state: QueryState, schema: Any) -> None:
        active = self._get_active_tables(state)
        if not active:
            raise ValueError("Cannot aggregate before selecting a table.")
        function = getattr(action, "function", None)
        if not function or str(function).upper() not in self.ALLOWED_AGGREGATES:
            raise ValueError(
                f"Invalid aggregate function '{function}'. "
                f"Allowed: {sorted(self.ALLOWED_AGGREGATES)}"
            )
        column = getattr(action, "column", None)
        if not column:
            raise ValueError("AGGREGATE requires a column name.")
        if column == "*" and str(function).upper() != "COUNT":
            raise ValueError("Only COUNT can aggregate '*'.")
        table = getattr(action, "table", None)
        if not self._resolve_column(column, table, active, schema):
            raise ValueError(f"Column '{column}' not found in active tables: {active}.")

    def _validate_order_by(self, action: Any, state: QueryState, schema: Any) -> None:
        active = self._get_active_tables(state)
        if not active:
            raise ValueError("Cannot order by before selecting a table.")
        col = getattr(action, "column", None)
        if not col:
            raise ValueError("ORDER_BY requires a column name.")
        direction = getattr(action, "direction", "ASC")
        if direction.upper() not in self.ALLOWED_ORDER_DIRECTIONS:
            raise ValueError(f"Invalid order direction '{direction}'. Must be ASC or DESC.")
        table = getattr(action, "table", None)
        if not self._resolve_column(col, table, active, schema):
            raise ValueError(f"Column '{col}' not found in active tables: {active}.")

    def _validate_limit(self, action: Any, state: QueryState, schema: Any) -> None:
        active = self._get_active_tables(state)
        if not active:
            raise ValueError("Cannot apply limit before selecting a table.")
        limit = getattr(action, "limit", None)
        if limit is None or not isinstance(limit, int) or limit <= 0:
            raise ValueError("LIMIT must be a positive integer.")

    def _validate_finish(self, action: Any, state: QueryState, schema: Any) -> None:
        active = self._get_active_tables(state)
        if not active:
            raise ValueError("Cannot finish query without selecting a table.")

    def _validate_insufficient_info(self, action: Any, state: QueryState, schema: Any) -> None:
        reason = getattr(action, "reason", None)
        if not reason or not str(reason).strip():
            raise ValueError("INSUFFICIENT_INFO requires a non-empty 'reason'.")

    def _validate_schema_missing(self, action: Any, state: QueryState, schema: Any) -> None:
        reason = getattr(action, "reason", None)
        if not reason or not str(reason).strip():
            raise ValueError("SCHEMA_MISSING requires a non-empty 'reason'.")

    def _validate_abort_query(self, action: Any, state: QueryState, schema: Any) -> None:
        # ABORT_QUERY is allowed at any state, including the empty root state.
        return
