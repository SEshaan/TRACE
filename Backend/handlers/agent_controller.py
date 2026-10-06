from __future__ import annotations

import os
from typing import Any, Literal
from handlers.decision_model import RuleBasedDecisionModel
from handlers.query_handler import DecisionModel, QueryAction, QueryState


AgentType = Literal["ornith", "laya", "rule"]


class AgentController(DecisionModel):
    """
    Central controller that dispatches decision-making to the selected
    decision model adapter (e.g., 'ornith', 'laya' (future), or 'rule').

    Allows dynamic swapping between models without modifying QueryHandler or API routes.
    """

    def __init__(
        self,
        default_agent: AgentType = "rule",
        *,
        base_url: str = "http://localhost:1234/v1",
        model_name: str = "ornith-1.5",
        temperature: float = 0.0,
    ):
        self.active_agent_type: AgentType = default_agent
        self.base_url = base_url
        self.model_name = model_name
        self.temperature = temperature
        self._registry: dict[str, DecisionModel] = {}

        # Pre-register default rule model
        self.register("rule", RuleBasedDecisionModel())

        # If ornith is requested or default, initialize it lazily or on demand
        if default_agent == "ornith":
            self.switch_to("ornith")

    def register(self, name: str, model: DecisionModel) -> None:
        """Register a decision model instance under an identifier."""
        self._registry[name.lower()] = model

    def switch_to(self, agent_type: str) -> None:
        """Switch active adapter to ornith, laya, or rule."""
        normalized = agent_type.lower()
        if normalized == "ornith" and "ornith" not in self._registry:
            from ml_adapters.ornith_decision_model import OrnithDecisionModel
            self._registry["ornith"] = OrnithDecisionModel(
                base_url=self.base_url,
                model=self.model_name,
                temperature=self.temperature,
            )
        elif normalized == "laya" and "laya" not in self._registry:
            # Future Laya adapter hook
            raise NotImplementedError("Laya adapter is not yet available. Use 'ornith' or 'rule'.")

        if normalized not in self._registry:
            raise ValueError(f"Unknown agent type: {agent_type}. Registered: {list(self._registry.keys())}")

        self.active_agent_type = normalized  # type: ignore[assignment]

    @property
    def current_model(self) -> DecisionModel:
        if self.active_agent_type not in self._registry:
            self.switch_to(self.active_agent_type)
        return self._registry[self.active_agent_type]

    def decide(
        self,
        *,
        request: str,
        state: QueryState,
        environment: Any,
    ) -> QueryAction:
        """Forward decision request to active model."""
        return self.current_model.decide(
            request=request,
            state=state,
            environment=environment,
        )


def create_agent_controller() -> AgentController:
    """Factory helper using environment variables."""
    agent_type = os.environ.get("DECISION_AGENT", "rule")
    base_url = os.environ.get("LM_STUDIO_URL", "http://localhost:1234/v1")
    model_name = os.environ.get("DECISION_MODEL_NAME", "ornith-1.5")
    return AgentController(
        default_agent=agent_type,  # type: ignore[arg-type]
        base_url=base_url,
        model_name=model_name,
    )
