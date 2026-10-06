from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any, Protocol, Sequence


# ---------------------------------------------------------------------------
# Query lifecycle
# ---------------------------------------------------------------------------


class QueryStatus(str, Enum):
    NEW = "new"
    ACTIVE = "active"
    FAILED = "failed"
    COMPLETED = "completed"


# ---------------------------------------------------------------------------
# Typed actions
# ---------------------------------------------------------------------------


class QueryAction(Protocol):
    """
    Marker protocol for all legal query actions.

    Concrete actions will be implemented separately:

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


# ---------------------------------------------------------------------------
# Query state
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class QueryState:
    """
    Immutable representation of the query at one point in the action graph.

    The state is produced by the QueryStateEngine, not by the handler.
    """

    id: str
    parent_id: str | None

    actions: tuple[QueryAction, ...]

    status: QueryStatus

    # The compiled SQL for this state, if one exists.
    sql: str | None = None

    # Most recent preview/execution result.
    result: Any | None = None


@dataclass(frozen=True)
class Checkpoint:
    id: str
    state_id: str


@dataclass(frozen=True)
class ActionResult:
    """
    Result returned after attempting to apply an action.
    """

    state: QueryState

    success: bool

    error: str | None = None

    # SQL generated for this action/state.
    sql: str | None = None

    # Bounded intermediate result.
    preview: Any | None = None

    # Execution metadata.
    execution_time_ms: float | None = None


@dataclass(frozen=True)
class QueryResult:
    """
    Final FINISH result.
    """

    state: QueryState

    sql: str

    columns: list[str]

    rows: list[dict[str, Any]]

    row_count: int

    execution_time_ms: float


@dataclass(frozen=True)
class QuerySession:
    """
    Represents one user-level query.

    A session may contain multiple query-state branches.
    """

    id: str

    request: str

    root_state_id: str

    current_state_id: str

    status: QueryStatus


@dataclass(frozen=True)
class QueryTrace:
    """
    Complete execution history.

    The concrete graph representation belongs to the trace store.
    """

    session: QuerySession

    states: Sequence[QueryState]

    checkpoints: Sequence[Checkpoint]

    failures: Sequence[Any]


# ---------------------------------------------------------------------------
# Offloaded components
# ---------------------------------------------------------------------------


class DecisionModel(Protocol):
    """
    Converts natural language/context into a typed action.

    The decision model does NOT execute anything.
    """

    def decide(
        self,
        request: str,
        state: QueryState,
        environment: Any,
    ) -> QueryAction:
        ...


class QueryStateEngine(Protocol):
    """
    Produces the next immutable query state from an action.
    """

    def apply(
        self,
        state: QueryState,
        action: QueryAction,
    ) -> QueryState:
        ...

    def branch(
        self,
        state: QueryState,
    ) -> QueryState:
        ...


class Validator(Protocol):
    """
    Deterministic action validator.

    No LLM decisions should happen here.
    """

    def validate(
        self,
        action: QueryAction,
        state: QueryState,
        environment: Any,
    ) -> None:
        ...


class SQLCompiler(Protocol):
    """
    Converts a validated query state into SQL.
    """

    def compile(
        self,
        state: QueryState,
    ) -> tuple[str, tuple[Any, ...]]:
        ...


class DatabaseAdapter(Protocol):
    """
    Read-only database execution interface.
    """

    def preview(
        self,
        sql: str,
        parameters: Sequence[Any] = (),
        *,
        limit: int = 50,
    ) -> Any:
        ...

    def query(
        self,
        sql: str,
        parameters: Sequence[Any] = (),
    ) -> Any:
        ...


class TraceStore(Protocol):
    """
    Persistence boundary.

    The handler should not know whether this eventually uses SQLite,
    PostgreSQL, etc.
    """

    def create_session(
        self,
        request: str,
        root_state: QueryState,
    ) -> QuerySession:
        ...

    def save_state(
        self,
        session_id: str,
        state: QueryState,
    ) -> None:
        ...

    def save_failure(
        self,
        session_id: str,
        state_id: str,
        action: QueryAction,
        error: str,
    ) -> None:
        ...

    def save_checkpoint(
        self,
        session_id: str,
        checkpoint: Checkpoint,
    ) -> None:
        ...

    def get_state(
        self,
        state_id: str,
    ) -> QueryState:
        ...

    def get_checkpoint(
        self,
        checkpoint_id: str,
    ) -> Checkpoint:
        ...

    def get_trace(
        self,
        session_id: str,
    ) -> QueryTrace:
        ...

    def update_session(
        self,
        session_id: str,
        *,
        current_state_id: str,
        status: QueryStatus,
    ) -> None:
        ...


class SchemaProvider(Protocol):
    """
    Provides the environment available to the decision model and validator.
    """

    def get_schema(self) -> Any:
        ...


# ---------------------------------------------------------------------------
# Query Handler
# ---------------------------------------------------------------------------


class QueryHandler:
    """
    Orchestrates the complete query lifecycle.

    The handler deliberately contains no:
      - SQL generation
      - validation rules
      - LLM logic
      - database-specific logic
      - persistence implementation

    It coordinates those components.
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
    ):
        self.decision_model = decision_model
        self.state_engine = state_engine
        self.validator = validator
        self.compiler = compiler
        self.database = database
        self.trace_store = trace_store
        self.schema_provider = schema_provider
        self.preview_limit = preview_limit

    # ------------------------------------------------------------------
    # Session lifecycle
    # ------------------------------------------------------------------

    def create(
        self,
        request: str,
    ) -> QuerySession:
        """
        Create a new query session with an empty/root state.
        """
        if not request.strip():
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
        )

    # ------------------------------------------------------------------
    # Decision
    # ------------------------------------------------------------------

    def next_action(
        self,
        session_id: str,
    ) -> QueryAction:
        """
        Ask the decision model for the next action.

        No execution happens here.
        """
        session = self._get_session(session_id)
        state = self.trace_store.get_state(
            session.current_state_id,
        )

        environment = self.schema_provider.get_schema()

        return self.decision_model.decide(
            request=session.request,
            state=state,
            environment=environment,
        )

    # ------------------------------------------------------------------
    # Action execution
    # ------------------------------------------------------------------

    def apply_action(
        self,
        session_id: str,
        action: QueryAction,
    ) -> ActionResult:
        """
        Execute one typed query action.

        Pipeline:

            action
              ↓
            validate
              ↓
            state transition
              ↓
            compile
              ↓
            preview
              ↓
            persist
        """
        session = self._get_session(session_id)

        current_state = self.trace_store.get_state(
            session.current_state_id,
        )

        environment = self.schema_provider.get_schema()

        # --------------------------------------------------------------
        # Deterministic validation
        # --------------------------------------------------------------

        try:
            self.validator.validate(
                action=action,
                state=current_state,
                environment=environment,
            )
        except Exception as exc:
            error = str(exc)

            self.trace_store.save_failure(
                session_id=session_id,
                state_id=current_state.id,
                action=action,
                error=error,
            )

            self.trace_store.update_session(
                session_id,
                current_state_id=current_state.id,
                status=QueryStatus.FAILED,
            )

            return ActionResult(
                state=current_state,
                success=False,
                error=error,
            )

        # --------------------------------------------------------------
        # Produce next state
        # --------------------------------------------------------------

        next_state = self.state_engine.apply(
            current_state,
            action,
        )

        # --------------------------------------------------------------
        # Compile
        # --------------------------------------------------------------

        sql, parameters = self.compiler.compile(
            next_state,
        )

        # --------------------------------------------------------------
        # Intermediate execution
        # --------------------------------------------------------------

        preview = self.database.preview(
            sql,
            parameters,
            limit=self.preview_limit,
        )

        # --------------------------------------------------------------
        # Persist state
        # --------------------------------------------------------------

        next_state = QueryState(
            id=next_state.id,
            parent_id=next_state.parent_id,
            actions=next_state.actions,
            status=QueryStatus.ACTIVE,
            sql=sql,
            result=preview.result,
        )

        self.trace_store.save_state(
            session_id,
            next_state,
        )

        self.trace_store.update_session(
            session_id,
            current_state_id=next_state.id,
            status=QueryStatus.ACTIVE,
        )

        return ActionResult(
            state=next_state,
            success=True,
            sql=sql,
            preview=preview.result,
        )

    # ------------------------------------------------------------------
    # Checkpoints
    # ------------------------------------------------------------------

    def checkpoint(
        self,
        session_id: str,
    ) -> Checkpoint:
        """
        Mark the current state as a recovery point.
        """
        session = self._get_session(session_id)

        checkpoint = Checkpoint(
            id=self._new_id(),
            state_id=session.current_state_id,
        )

        self.trace_store.save_checkpoint(
            session_id,
            checkpoint,
        )

        return checkpoint

    # ------------------------------------------------------------------
    # Recovery
    # ------------------------------------------------------------------

    def recover(
        self,
        session_id: str,
        checkpoint_id: str,
        correction: QueryAction | Sequence[QueryAction],
    ) -> ActionResult:
        """
        Create a new branch from a checkpoint and apply the correction.

        Existing failed/superseded paths remain in the trace.
        """
        checkpoint = self.trace_store.get_checkpoint(
            checkpoint_id,
        )

        checkpoint_state = self.trace_store.get_state(
            checkpoint.state_id,
        )

        self.trace_store.update_session(
            session_id,
            current_state_id=checkpoint_state.id,
            status=QueryStatus.ACTIVE,
        )

        actions = (
            [correction]
            if not isinstance(correction, Sequence)
            else list(correction)
        )

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
                "recovery requires at least one correction"
            )

        return result

    # ------------------------------------------------------------------
    # Final execution
    # ------------------------------------------------------------------

    def finish(
        self,
        session_id: str,
    ) -> QueryResult:
        """
        Execute the current query as the final result.

        FINISH itself is represented by the lifecycle transition rather
        than by adding arbitrary SQL to the query.
        """
        session = self._get_session(session_id)

        state = self.trace_store.get_state(
            session.current_state_id,
        )

        sql, parameters = self.compiler.compile(
            state,
        )

        result = self.database.query(
            sql,
            parameters,
        )

        self.trace_store.update_session(
            session_id,
            current_state_id=state.id,
            status=QueryStatus.COMPLETED,
        )

        return QueryResult(
            state=QueryState(
                id=state.id,
                parent_id=state.parent_id,
                actions=state.actions,
                status=QueryStatus.COMPLETED,
                sql=sql,
                result=result,
            ),
            sql=sql,
            columns=result.columns,
            rows=result.rows,
            row_count=result.row_count,
            execution_time_ms=0.0,
        )

    # ------------------------------------------------------------------
    # Inspection
    # ------------------------------------------------------------------

    def get_state(
        self,
        session_id: str,
    ) -> QueryState:
        session = self._get_session(session_id)

        return self.trace_store.get_state(
            session.current_state_id,
        )

    def get_trace(
        self,
        session_id: str,
    ) -> QueryTrace:
        return self.trace_store.get_trace(
            session_id,
        )

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _get_session(
        self,
        session_id: str,
    ) -> QuerySession:
        """
        This will eventually be a TraceStore lookup.

        Kept isolated so the handler has only one persistence boundary.
        """
        trace = self.trace_store.get_trace(session_id)

        return trace.session

    @staticmethod
    def _new_id() -> str:
        """
        Temporary ID generation.

        Replace with the project's ID strategy later.
        """
        import uuid

        return str(uuid.uuid4())
