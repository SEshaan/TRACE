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


@dataclass(frozen=True)
class InsufficientInfoAction:
    """Graceful fail: the prompt lacks a fact needed to build the query.

    A soft branch-stopper. The agent stops here and asks for clarification;
    the branch can still be recovered by branching from an earlier checkpoint.
    """

    reason: str = ""
    clarification: str = ""
    missing_fields: list[str] | None = None
    action_type: str = "INSUFFICIENT_INFO"
    confidence: float = 1.0

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class SchemaMissingAction:
    """Graceful fail: the DB lacks a table/column/relationship required by the request.

    A soft branch-stopper. The agent reports which object is missing and does not
    invent it; the branch can still be recovered from an earlier checkpoint.
    """

    reason: str = ""
    table: str | None = None
    column: str | None = None
    expected_relationship: str | None = None
    action_type: str = "SCHEMA_MISSING"
    confidence: float = 1.0

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class AbortQueryAction:
    """Graceful fail: the agent cannot satisfy the request at all.

    A hard terminal failure. Only used when backtracking has reached the root /
    first state and there is nothing left to try.
    """

    action_type: str = "ABORT_QUERY"
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
    | InsufficientInfoAction
    | SchemaMissingAction
    | AbortQueryAction
)
