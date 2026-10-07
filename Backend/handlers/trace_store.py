from __future__ import annotations

from typing import Any
from handlers.query_handler import (
    ActionFailure,
    Checkpoint,
    QueryAction,
    QuerySession,
    QueryState,
    QueryStatus,
    QueryTrace,
    TraceStore,
)


class InMemoryTraceStore(TraceStore):
    """
    In-memory trace store for session, state, checkpoint, and failure persistence.
    """

    def __init__(self) -> None:
        self._sessions: dict[str, QuerySession] = {}
        self._states: dict[str, QueryState] = {}
        self._session_states: dict[str, list[str]] = {}
        self._checkpoints: dict[str, Checkpoint] = {}
        self._session_checkpoints: dict[str, list[str]] = {}
        self._session_failures: dict[str, list[ActionFailure]] = {}

    def create_session(
        self,
        *,
        request: str,
        root_state: QueryState,
        model_version: str | None = None,
    ) -> QuerySession:
        import uuid
        from datetime import datetime, timezone

        now = datetime.now(timezone.utc).isoformat()
        session_id = str(uuid.uuid4())
        session = QuerySession(
            id=session_id,
            request=request,
            root_state_id=root_state.id,
            current_state_id=root_state.id,
            status=QueryStatus.NEW,
            model_version=model_version,
            created_at=now,
            updated_at=now,
        )
        self._sessions[session_id] = session
        self._session_states[session_id] = []
        self._session_checkpoints[session_id] = []
        self._session_failures[session_id] = []
        return session

    def get_session(
        self,
        session_id: str,
    ) -> QuerySession:
        if session_id not in self._sessions:
            raise KeyError(f"Session '{session_id}' not found.")
        return self._sessions[session_id]

    def update_session(
        self,
        session_id: str,
        *,
        current_state_id: str,
        status: QueryStatus,
    ) -> None:
        from datetime import datetime, timezone

        now = datetime.now(timezone.utc).isoformat()
        session = self.get_session(session_id)
        self._sessions[session_id] = QuerySession(
            id=session.id,
            request=session.request,
            root_state_id=session.root_state_id,
            current_state_id=current_state_id,
            status=status,
            model_version=session.model_version,
            created_at=session.created_at or now,
            updated_at=now,
        )

    def list_sessions(
        self,
        *,
        status: str | None = None,
        q: str | None = None,
        limit: int = 50,
    ) -> list[dict[str, Any]]:
        results = []
        for s in reversed(list(self._sessions.values())):
            status_val = s.status.value if hasattr(s.status, "value") else str(s.status)
            if status and status_val != status:
                continue
            if q and q.lower() not in s.request.lower():
                continue
            state_count = len(self._session_states.get(s.id, []))
            has_failure = len(self._session_failures.get(s.id, [])) > 0
            results.append({
                "id": s.id,
                "request": s.request,
                "status": status_val,
                "model_version": s.model_version,
                "created_at": s.created_at,
                "updated_at": s.updated_at,
                "state_count": state_count,
                "has_failure": has_failure,
            })
            if len(results) >= limit:
                break
        return results

    def save_state(
        self,
        session_id: str,
        state: QueryState,
    ) -> None:
        self._states[state.id] = state
        if session_id in self._session_states:
            if state.id not in self._session_states[session_id]:
                self._session_states[session_id].append(state.id)

    def get_state(
        self,
        state_id: str,
    ) -> QueryState:
        if state_id not in self._states:
            raise KeyError(f"State '{state_id}' not found.")
        return self._states[state_id]

    def save_failure(
        self,
        *,
        session_id: str,
        state_id: str,
        action: QueryAction,
        failure: ActionFailure,
    ) -> None:
        if session_id in self._session_failures:
            self._session_failures[session_id].append(failure)

    def save_checkpoint(
        self,
        *,
        session_id: str,
        checkpoint: Checkpoint,
    ) -> None:
        self._checkpoints[checkpoint.id] = checkpoint
        if session_id in self._session_checkpoints:
            self._session_checkpoints[session_id].append(checkpoint.id)

    def get_checkpoint(
        self,
        checkpoint_id: str,
    ) -> Checkpoint:
        if checkpoint_id not in self._checkpoints:
            raise KeyError(f"Checkpoint '{checkpoint_id}' not found.")
        return self._checkpoints[checkpoint_id]

    def get_trace(
        self,
        session_id: str,
    ) -> QueryTrace:
        session = self.get_session(session_id)
        states = [
            self._states[sid]
            for sid in self._session_states.get(session_id, [])
            if sid in self._states
        ]
        checkpoints = [
            self._checkpoints[cid]
            for cid in self._session_checkpoints.get(session_id, [])
            if cid in self._checkpoints
        ]
        failures = self._session_failures.get(session_id, [])
        return QueryTrace(
            session=session,
            states=tuple(states),
            checkpoints=tuple(checkpoints),
            failures=tuple(failures),
        )
