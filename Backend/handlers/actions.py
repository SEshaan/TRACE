from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Literal


@dataclass(frozen=True)
class SelectTableAction:
    """Select a base table to query."""

    table: str
    action_type: str = "SELECT_TABLE"
    confidence: float = 1.0

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class SelectColumnAction:
    """Select a column to include in the query projection."""

    column: str
    table: str | None = None
    alias: str | None = None
    action_type: str = "SELECT_COLUMN"
    confidence: float = 1.0

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class FilterAction:
    """Filter rows with a column predicate."""

    column: str
    operator: str  # '=', '!=', '>', '>=', '<', '<=', 'LIKE', 'IN', 'IS NULL', 'IS NOT NULL'
    value: Any
    table: str | None = None
    action_type: str = "FILTER"
    confidence: float = 1.0

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class JoinAction:
    """Join another table on a foreign key or join condition."""

    table: str
    left_on: str
    right_on: str
    join_type: Literal["INNER", "LEFT", "RIGHT"] = "INNER"
    action_type: str = "JOIN"
    confidence: float = 1.0

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class GroupByAction:
    """Group rows by a column."""

    column: str
    table: str | None = None
    action_type: str = "GROUP_BY"
    confidence: float = 1.0

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class OrderByAction:
    """Sort query results."""

    column: str
    direction: Literal["ASC", "DESC"] = "ASC"
    table: str | None = None
    action_type: str = "ORDER_BY"
    confidence: float = 1.0

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class LimitAction:
    """Restrict number of rows returned."""

    limit: int
    action_type: str = "LIMIT"
    confidence: float = 1.0

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class FinishAction:
    """Mark the query plan as complete."""

    action_type: str = "FINISH"
    confidence: float = 1.0

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


ActionUnion = (
    SelectTableAction
    | SelectColumnAction
    | FilterAction
    | JoinAction
    | GroupByAction
    | OrderByAction
    | LimitAction
    | FinishAction
)
