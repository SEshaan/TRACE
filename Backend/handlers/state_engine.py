from __future__ import annotations

from uuid import uuid4
from handlers.query_handler import QueryAction, QueryState, QueryStateEngine, QueryStatus


class DefaultQueryStateEngine(QueryStateEngine):
    """
    Applies typed actions to immutable query states and manages branching.
    """

    def apply(
        self,
        *,
        state: QueryState,
        action: QueryAction,
    ) -> QueryState:
        new_actions = (*state.actions, action)
        return QueryState(
            id=str(uuid4()),
            parent_id=state.id,
            actions=new_actions,
            status=QueryStatus.ACTIVE,
            sql=None,
            preview=None,
        )

    def branch(
        self,
        *,
        state: QueryState,
    ) -> QueryState:
        """
        Creates an explicit branch state rooted at the checkpoint state.
        """
        return QueryState(
            id=str(uuid4()),
            parent_id=state.id,
            actions=state.actions,
            status=QueryStatus.ACTIVE,
            sql=state.sql,
            preview=state.preview,
        )
