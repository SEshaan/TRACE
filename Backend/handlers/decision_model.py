from __future__ import annotations

from typing import Any
from handlers.actions import FinishAction, SelectColumnAction, SelectTableAction
from handlers.query_handler import DecisionModel, QueryAction, QueryState


class RuleBasedDecisionModel(DecisionModel):
    """
    Fallback deterministic decision model when no LLM service is active.
    Translates simple requests or follows a basic sequence.
    """

    def decide(
        self,
        *,
        request: str,
        state: QueryState,
        environment: Any,
    ) -> QueryAction:
        schema = environment
        actions = state.actions

        # Step 1: Select table if none selected
        if not actions:
            req_lower = request.lower()
            if schema:
                for table in schema.tables:
                    if table.name.lower() in req_lower:
                        return SelectTableAction(table=table.name)
                # Default to first table if found
                if schema.tables:
                    return SelectTableAction(table=schema.tables[0].name)
            return SelectTableAction(table="students")

        # Step 2: Select all columns
        has_columns = any(getattr(a, "action_type", "") == "SELECT_COLUMN" for a in actions)
        if not has_columns:
            return SelectColumnAction(column="*")

        # Step 3: Finish
        return FinishAction()
