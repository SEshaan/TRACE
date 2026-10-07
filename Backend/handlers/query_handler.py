from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any, Protocol, Sequence
from uuid import uuid4

# ============================================================================
# Query lifecycle
# ============================================================================


class QueryStatus(str, Enum):
    NEW = "new"
    ACTIVE = "active"
    FAILED = "failed"
    COMPLETED = "completed"


# ============================================================================
# Typed actions
# ============================================================================


class QueryAction(Protocol):
    """
    Marker protocol for legal query actions.

    Concrete implementations:
        SelectTableAction
        SelectColumnAction
        FilterAction
        JoinAction
        GroupByAction
        OrderByAction
        LimitAction
        FinishAction
    """

    action_type: str


# ============================================================================
# Execution / preview models
# ============================================================================


@dataclass(frozen=True)
class PreviewResult:
    """
    Bounded result produced after executing an intermediate query state.
    """

    columns: tuple[str, ...]
    rows: tuple[dict[str, Any], ...]
    row_count: int

    # True when the database returned more rows than were included in `rows`.
    truncated: bool

    execution_time_ms: float


@dataclass(frozen=True)
class ExecutionResult:
    """
    Result of a database execution.

    Used for both intermediate previews and final execution.
    """

    columns: tuple[str, ...]
    rows: tuple[dict[str, Any], ...]
    row_count: int
    execution_time_ms: float


@dataclass(frozen=True)
class ActionFailure:
    """
    Structured failure information.

    Keeping failures typed makes them easier to persist, inspect,
    display in React Flow, and recover from.
    """

    action_type: str
    code: str
    message: str


# ============================================================================
# Query state
# ============================================================================


@dataclass(frozen=True)
class QueryState:
    """
    Immutable representation of a query at one point in the graph.

    Every successful action creates a new state.

    parent_id establishes the graph relationship:

        parent state
              |
              v
        current state
    """

    id: str
    parent_id: str | None

    actions: tuple[QueryAction, ...]

    status: QueryStatus

    # Compiled SQL corresponding to this state.
    sql: str | None = None

    # Most recent bounded execution result.
    preview: PreviewResult | None = None


@dataclass(frozen=True)
class Checkpoint:
    """
    A named recovery point in the query graph.
    """

    id: str
    state_id: str
    label: str | None = None


# ============================================================================
# Action result
# ============================================================================


@dataclass(frozen=True)
class ActionResult:
    """
    Result of attempting to apply one action.
    """

    state: QueryState

    preview: PreviewResult | None = None

    failure: ActionFailure | None = None

    @property
    def success(self) -> bool:
        return self.failure is None


# ============================================================================
# Final query result
# ============================================================================


@dataclass(frozen=True)
class QueryResult:
    """
    Final result returned after FINISH.
    """

    state: QueryState

    sql: str

    columns: tuple[str, ...]

    rows: tuple[dict[str, Any], ...]

    row_count: int

    execution_time_ms: float


# ============================================================================
# Session / trace
# ============================================================================


@dataclass(frozen=True)
class QuerySession:
    """
    Represents a user-level query.

    A session may contain multiple branches of QueryState.
    """

    id: str

    request: str

    root_state_id: str

    current_state_id: str

    status: QueryStatus

    model_version: str | None = None
    created_at: str | None = None
    updated_at: str | None = None


@dataclass(frozen=True)
class QueryTrace:
    """
    Complete persisted execution history for a session.
    """

    session: QuerySession

    states: Sequence[QueryState]

    checkpoints: Sequence[Checkpoint]

    failures: Sequence[ActionFailure]


# ============================================================================
# Decision model
# ============================================================================


class DecisionModel(Protocol):
    """
    Converts natural language + current state into a legal typed action.

    The decision model never generates or executes SQL directly.
    """

    def decide(
        self,
        *,
        request: str,
        state: QueryState,
        environment: Any,
        graph_context: dict | None = None,
    ) -> QueryAction:
        ...


def _ancestors_of(state_id, states_by_id):
    """Ordered ancestor chain (nearest first) for a state id."""
    chain = []
    seen = set()
    current = states_by_id.get(state_id)
    while current is not None and current.id not in seen:
        seen.add(current.id)
        chain.append(current)
        parent = states_by_id.get(current.parent_id) if current.parent_id else None
        current = parent
    return chain


def build_graph_context(session, states, checkpoints, failures):
    """
    Compact awareness of the *whole* query graph for the decision model.

    The linear `state.actions` only describes the current path. This adds:
      - sibling_actions: alternative action types already tried at each depth
        (rejected / abandoned branches off the same ancestor).
      - recent_failures: the most recent failed actions (rejected work).
      - is_recovered_branch: whether we are on a branch that recovered from a
        checkpoint and moved past it.

    This lets the model avoid repeating an action that was already tried and
    dropped, instead of guessing as if every step were fresh.
    """
    states_by_id = {s.id: s for s in states}
    current_id = session.current_state_id

    ancestors = _ancestors_of(current_id, states_by_id)
    ancestor_ids = {a.id for a in ancestors}

    # Checkpoints whose state is an *ancestor* of the current node means we
    # branched off that checkpoint and moved past it -> recovered branch.
    cp_state_ids = {c.state_id for c in checkpoints}
    is_recovered_branch = bool(cp_state_ids & ancestor_ids)

    # Alternatives = states not on the current path. Group their action types
    # by depth so the model knows what was already tried at each level.
    sibling_actions = {}
    for s in states:
        if s.id in ancestor_ids or s.id == current_id:
            continue
        depth = len(_ancestors_of(s.id, states_by_id))
        action_type = getattr(s.actions[-1], "action_type", None) if s.actions else None
        if not action_type:
            continue
        sibling_actions.setdefault(depth, set()).add(action_type)
    sibling_actions = {int(d): sorted(types) for d, types in sibling_actions.items()}

    recent_failures = [
        {"action_type": f.action_type, "code": f.code}
        for f in list(failures)[-5:]
    ]

    return {
        "is_recovered_branch": is_recovered_branch,
        "sibling_actions": sibling_actions,
        "recent_failures": recent_failures,
    }


# ============================================================================
# Query state engine
# ============================================================================


class QueryStateEngine(Protocol):
    """
    Applies typed actions to immutable query states.
    """

    def apply(
        self,
        *,
        state: QueryState,
        action: QueryAction,
    ) -> QueryState:
        ...

    def branch(
        self,
        *,
        state: QueryState,
    ) -> QueryState:
        ...


# ============================================================================
# Deterministic validator
# ============================================================================


class Validator(Protocol):
    """
    Deterministic validation boundary.

    No LLM reasoning should happen here.
    """

    def validate(
        self,
        *,
        action: QueryAction,
        state: QueryState,
        environment: Any,
    ) -> None:
        ...


# ============================================================================
# SQL compiler
# ============================================================================


class SQLCompiler(Protocol):
    """
    Compiles a validated QueryState into parameterized SQL.

    The compiler owns SQL generation.
    The decision model does not.
    """

    def compile(
        self,
        *,
        state: QueryState,
    ) -> tuple[str, tuple[Any, ...]]:
        ...


# ============================================================================
# Database
# ============================================================================


class DatabaseAdapter(Protocol):
    """
    Database execution boundary.

    The handler does not know whether the implementation is SQLite,
    PostgreSQL, etc.
    """

    def execute(
        self,
        sql: str,
        parameters: Sequence[Any] = (),
        *,
        max_rows: int | None = None,
    ) -> ExecutionResult:
        ...


# ============================================================================
# Schema provider
# ============================================================================


class SchemaProvider(Protocol):
    """
    Provides the environment available to the decision model and validator.

    This can later expose:
        - tables
        - columns
        - types
        - relationships
        - constraints
        - permissions
    """

    def get_schema(self) -> Any:
        ...


# ============================================================================
# Trace store
# ============================================================================


class TraceStore(Protocol):
    """
    Persistence boundary.

    The handler does not know whether this is backed by SQLite,
    PostgreSQL, or another RDBMS.
    """

    # ------------------------------------------------------------------
    # Sessions
    # ------------------------------------------------------------------

    def create_session(
        self,
        *,
        request: str,
        root_state: QueryState,
        model_version: str | None = None,
    ) -> QuerySession:
        ...

    def get_session(
        self,
        session_id: str,
    ) -> QuerySession:
        ...

    def update_session(
        self,
        session_id: str,
        *,
        current_state_id: str,
        status: QueryStatus,
    ) -> None:
        ...

    def list_sessions(
        self,
        *,
        status: str | None = None,
        q: str | None = None,
        limit: int = 50,
    ) -> Sequence[dict[str, Any]]:
        ...

    # ------------------------------------------------------------------
    # States
    # ------------------------------------------------------------------

    def save_state(
        self,
        session_id: str,
        state: QueryState,
    ) -> None:
        ...

    def get_state(
        self,
        state_id: str,
    ) -> QueryState:
        ...

    # ------------------------------------------------------------------
    # Failures
    # ------------------------------------------------------------------

    def save_failure(
        self,
        *,
        session_id: str,
        state_id: str,
        action: QueryAction,
        failure: ActionFailure,
    ) -> None:
        ...

    # ------------------------------------------------------------------
    # Checkpoints
    # ------------------------------------------------------------------

    def save_checkpoint(
        self,
        *,
        session_id: str,
        checkpoint: Checkpoint,
    ) -> None:
        ...

    def get_checkpoint(
        self,
        checkpoint_id: str,
    ) -> Checkpoint:
        ...

    # ------------------------------------------------------------------
    # Trace
    # ------------------------------------------------------------------

    def get_trace(
        self,
        session_id: str,
    ) -> QueryTrace:
        ...


# ============================================================================
# Query Handler
# ============================================================================


class QueryHandler:
    """
    Orchestrates the query execution lifecycle.

    The handler coordinates components but does not own their logic.

    Responsibilities:

        Natural language request
                ↓
        DecisionModel
                ↓
        Typed QueryAction
                ↓
        Validator
                ↓
        QueryStateEngine
                ↓
        SQLCompiler
                ↓
        DatabaseAdapter
                ↓
        TraceStore

    The handler intentionally contains no:
        - SQL generation
        - validation rules
        - LLM implementation
        - database-specific code
        - persistence implementation
    """

    def __init__(
        self,
        *,
        decision_model: DecisionModel,
        state_engine: QueryStateEngine,
        validator: Validator,
        compiler: SQLCompiler,
        database: DatabaseAdapter,
        trace_store: TraceStore,
        schema_provider: SchemaProvider,
        preview_limit: int = 50,
        model_version: str | None = None,
    ):
        if preview_limit <= 0:
            raise ValueError("preview_limit must be greater than zero")

        self.decision_model = decision_model
        self.state_engine = state_engine
        self.validator = validator
        self.compiler = compiler
        self.database = database
        self.trace_store = trace_store
        self.schema_provider = schema_provider

        self.preview_limit = preview_limit
        self.model_version = model_version

    # ======================================================================
    # Session lifecycle
    # ======================================================================

    def create(
        self,
        request: str,
    ) -> QuerySession:
        """
        Create a new query session with an empty root state.
        """

        request = request.strip()

        if not request:
            raise ValueError("query request cannot be empty")

        root_state = QueryState(
            id=self._new_id(),
            parent_id=None,
            actions=(),
            status=QueryStatus.NEW,
        )

        session = self.trace_store.create_session(
            request=request,
            root_state=root_state,
            model_version=self.model_version,
        )

        self.trace_store.save_state(
            session.id,
            root_state,
        )

        self.trace_store.update_session(
            session.id,
            current_state_id=root_state.id,
            status=QueryStatus.ACTIVE,
        )

        return QuerySession(
            id=session.id,
            request=session.request,
            root_state_id=session.root_state_id,
            current_state_id=root_state.id,
            status=QueryStatus.ACTIVE,
            model_version=session.model_version,
        )

    # ======================================================================
    # Decision
    # ======================================================================

    def next_action(
        self,
        session_id: str,
    ) -> QueryAction:
        """
        Ask the decision model for the next typed action.

        This method does not execute the action.
        """

        session = self.trace_store.get_session(session_id)

        state = self.trace_store.get_state(
            session.current_state_id,
        )

        environment = self.schema_provider.get_schema()

        # Full graph context so the model can avoid repeating rejected work on
        # sibling branches and after backtracking from a checkpoint.
        trace = self.trace_store.get_trace(session_id)
        graph_context = build_graph_context(
            session, trace.states, trace.checkpoints, trace.failures,
        )

        return self.decision_model.decide(
            request=session.request,
            state=state,
            environment=environment,
            graph_context=graph_context,
        )

    # ======================================================================
    # Apply action
    # ======================================================================

    def apply_action(
        self,
        session_id: str,
        action: QueryAction,
    ) -> ActionResult:
        """
        Validate and apply one typed query action.

        Pipeline:

            action
              ↓
            validate
              ↓
            state transition
              ↓
            compile
              ↓
            execute preview
              ↓
            persist state
        """

        session = self.trace_store.get_session(session_id)

        current_state = self.trace_store.get_state(
            session.current_state_id,
        )

        environment = self.schema_provider.get_schema()

        # ------------------------------------------------------------------
        # Deterministic validation
        # ------------------------------------------------------------------

        try:
            self.validator.validate(
                action=action,
                state=current_state,
                environment=environment,
            )

        except Exception as exc:
            failure = self._validation_failure(
                action=action,
                error=exc,
            )

            self.trace_store.save_failure(
                session_id=session_id,
                state_id=current_state.id,
                action=action,
                failure=failure,
            )

            self.trace_store.update_session(
                session_id,
                current_state_id=current_state.id,
                status=QueryStatus.FAILED,
            )

            return ActionResult(
                state=current_state,
                failure=failure,
            )

        # ------------------------------------------------------------------
        # State transition
        # ------------------------------------------------------------------

        try:
            next_state = self.state_engine.apply(
                state=current_state,
                action=action,
            )

        except Exception as exc:
            failure = ActionFailure(
                action_type=action.action_type,
                code="STATE_TRANSITION_FAILED",
                message=str(exc),
            )

            self.trace_store.save_failure(
                session_id=session_id,
                state_id=current_state.id,
                action=action,
                failure=failure,
            )

            self.trace_store.update_session(
                session_id,
                current_state_id=current_state.id,
                status=QueryStatus.FAILED,
            )

            return ActionResult(
                state=current_state,
                failure=failure,
            )

        # ------------------------------------------------------------------
        # Graceful fail actions: record a decision node and stop.
        # Fail actions (INSUFFICIENT_INFO / SCHEMA_MISSING / ABORT_QUERY) do
        # not build SQL, so we short-circuit before compile/execute. The new
        # state is persisted with sql=None and preview=None so the frontend
        # renders it as a decision node rather than an empty query.
        # ------------------------------------------------------------------

        if getattr(action, "action_type", None) in (
            "INSUFFICIENT_INFO",
            "SCHEMA_MISSING",
            "ABORT_QUERY",
        ):
            persisted_state = QueryState(
                id=next_state.id,
                parent_id=next_state.parent_id,
                actions=next_state.actions,
                status=QueryStatus.FAILED,
                sql=None,
                preview=None,
            )

            self.trace_store.save_state(
                session_id,
                persisted_state,
            )

            self.trace_store.update_session(
                session_id,
                current_state_id=persisted_state.id,
                status=QueryStatus.FAILED,
            )

            return ActionResult(
                state=persisted_state,
            )

        # ------------------------------------------------------------------
        # SQL compilation
        # ------------------------------------------------------------------

        try:
            sql, parameters = self.compiler.compile(
                state=next_state,
            )

        except Exception as exc:
            failure = ActionFailure(
                action_type=action.action_type,
                code="SQL_COMPILATION_FAILED",
                message=str(exc),
            )

            self.trace_store.save_failure(
                session_id=session_id,
                state_id=next_state.id,
                action=action,
                failure=failure,
            )

            self.trace_store.update_session(
                session_id,
                current_state_id=current_state.id,
                status=QueryStatus.FAILED,
            )

            return ActionResult(
                state=current_state,
                failure=failure,
            )

        # ------------------------------------------------------------------
        # Intermediate execution
        # ------------------------------------------------------------------

        try:
            execution = self.database.execute(
                sql,
                parameters,
                max_rows=self.preview_limit,
            )

        except Exception as exc:
            failure = ActionFailure(
                action_type=action.action_type,
                code="DATABASE_EXECUTION_FAILED",
                message=str(exc),
            )

            self.trace_store.save_failure(
                session_id=session_id,
                state_id=next_state.id,
                action=action,
                failure=failure,
            )

            self.trace_store.update_session(
                session_id,
                current_state_id=current_state.id,
                status=QueryStatus.FAILED,
            )

            return ActionResult(
                state=current_state,
                failure=failure,
            )

        # ------------------------------------------------------------------
        # Build preview
        # ------------------------------------------------------------------

        preview = self._to_preview(execution)

        persisted_state = QueryState(
            id=next_state.id,
            parent_id=next_state.parent_id,
            actions=next_state.actions,
            status=QueryStatus.ACTIVE,
            sql=sql,
            preview=preview,
        )

        # ------------------------------------------------------------------
        # Persist successful state
        # ------------------------------------------------------------------

        self.trace_store.save_state(
            session_id,
            persisted_state,
        )

        self.trace_store.update_session(
            session_id,
            current_state_id=persisted_state.id,
            status=QueryStatus.ACTIVE,
        )

        return ActionResult(
            state=persisted_state,
            preview=preview,
        )

    # ======================================================================
    # Step
    # ======================================================================

    def step(
        self,
        session_id: str,
    ) -> tuple[ActionResult, QueryAction]:
        """
        Decide the next action and apply it in a single step.
        """
        action = self.next_action(session_id)
        result = self.apply_action(session_id, action)
        return result, action

    # ======================================================================
    # Checkpoints
    # ======================================================================

    def checkpoint(
        self,
        session_id: str,
        *,
        state_id: str | None = None,
        label: str | None = None,
    ) -> Checkpoint:
        """
        Mark a specific state (or current state if None) as a recovery point.
        """

        session = self.trace_store.get_session(session_id)
        target_state_id = state_id if state_id is not None else session.current_state_id

        # Verify target state exists
        self.trace_store.get_state(target_state_id)

        checkpoint = Checkpoint(
            id=self._new_id(),
            state_id=target_state_id,
            label=label,
        )

        self.trace_store.save_checkpoint(
            session_id=session_id,
            checkpoint=checkpoint,
        )

        return checkpoint

    # ======================================================================
    # Session listing
    # ======================================================================

    def list_sessions(
        self,
        *,
        status: str | None = None,
        q: str | None = None,
        limit: int = 50,
    ) -> list[dict[str, Any]]:
        """
        Retrieve historical sessions with optional status and query filtering.
        """
        return list(self.trace_store.list_sessions(status=status, q=q, limit=limit))

    # ======================================================================
    # Recovery
    # ======================================================================

    def recover(
        self,
        session_id: str,
        checkpoint_id: str,
        correction: QueryAction | Sequence[QueryAction],
    ) -> ActionResult:
        """
        Recompute from a checkpoint.

        The existing path is never deleted.

        A new branch is created from the checkpoint state and the
        correction is applied to that branch.
        """

        checkpoint = self.trace_store.get_checkpoint(
            checkpoint_id,
        )

        checkpoint_state = self.trace_store.get_state(
            checkpoint.state_id,
        )

        # Create an explicit branch state.

        branch_state = self.state_engine.branch(
            state=checkpoint_state,
        )

        self.trace_store.save_state(
            session_id,
            branch_state,
        )

        self.trace_store.update_session(
            session_id,
            current_state_id=branch_state.id,
            status=QueryStatus.ACTIVE,
        )

        actions = self._normalize_actions(correction)

        result: ActionResult | None = None

        for action in actions:
            result = self.apply_action(
                session_id,
                action,
            )

            if not result.success:
                return result

        if result is None:
            raise ValueError(
                "recovery requires at least one correction",
            )

        return result

    # ======================================================================
    # Final execution
    # ======================================================================

    def finish(
        self,
        session_id: str,
    ) -> QueryResult:
        """
        Execute the current query as the final result.

        The current state is compiled and executed without a preview row
        limit.
        """

        session = self.trace_store.get_session(session_id)

        state = self.trace_store.get_state(
            session.current_state_id,
        )

        if not state.actions:
            raise ValueError(
                "cannot finish an empty query",
            )

        # ------------------------------------------------------------------
        # Compile
        # ------------------------------------------------------------------

        sql, parameters = self.compiler.compile(
            state=state,
        )

        # ------------------------------------------------------------------
        # Final database execution
        # ------------------------------------------------------------------

        execution = self.database.execute(
            sql,
            parameters,
            max_rows=None,
        )

        # ------------------------------------------------------------------
        # Persist completed state
        # ------------------------------------------------------------------

        completed_state = QueryState(
            id=state.id,
            parent_id=state.parent_id,
            actions=state.actions,
            status=QueryStatus.COMPLETED,
            sql=sql,
            preview=None,
        )

        self.trace_store.save_state(
            session_id,
            completed_state,
        )

        self.trace_store.update_session(
            session_id,
            current_state_id=completed_state.id,
            status=QueryStatus.COMPLETED,
        )

        return QueryResult(
            state=completed_state,
            sql=sql,
            columns=execution.columns,
            rows=execution.rows,
            row_count=execution.row_count,
            execution_time_ms=execution.execution_time_ms,
        )

    # ======================================================================
    # Inspection
    # ======================================================================

    def get_state(
        self,
        session_id: str,
    ) -> QueryState:
        """
        Get the current query state.
        """

        session = self.trace_store.get_session(session_id)

        return self.trace_store.get_state(
            session.current_state_id,
        )

    def get_trace(
        self,
        session_id: str,
    ) -> QueryTrace:
        """
        Get the complete execution trace for a session.
        """

        return self.trace_store.get_trace(session_id)

    # ======================================================================
    # Helpers
    # ======================================================================

    @staticmethod
    def _new_id() -> str:
        return str(uuid4())

    @staticmethod
    def _normalize_actions(
        correction: QueryAction | Sequence[QueryAction],
    ) -> tuple[QueryAction, ...]:
        """
        Normalize one correction or multiple corrections into a tuple.

        QueryAction itself is a Protocol, so we deliberately do not use
        isinstance() here.
        """

        if isinstance(correction, (list, tuple)):
            actions = tuple(correction)

        else:
            actions = (correction,)

        if not actions:
            raise ValueError(
                "recovery requires at least one correction",
            )

        return actions

    @staticmethod
    def _to_preview(
        execution: ExecutionResult,
    ) -> PreviewResult:
        """
        Convert an execution result into the bounded preview representation.
        """

        # The database adapter is responsible for enforcing max_rows.
        # Therefore a row count greater than the number of returned rows
        # means the result was truncated.
        truncated = execution.row_count > len(execution.rows)

        return PreviewResult(
            columns=execution.columns,
            rows=execution.rows,
            row_count=execution.row_count,
            truncated=truncated,
            execution_time_ms=execution.execution_time_ms,
        )

    @staticmethod
    def _validation_failure(
        *,
        action: QueryAction,
        error: Exception,
    ) -> ActionFailure:
        return ActionFailure(
            action_type=action.action_type,
            code="VALIDATION_FAILED",
            message=str(error),
        )
