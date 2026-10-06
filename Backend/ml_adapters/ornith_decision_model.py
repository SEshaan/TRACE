from __future__ import annotations

import json
from typing import Any
from handlers.actions import (
    FilterAction,
    FinishAction,
    GroupByAction,
    JoinAction,
    LimitAction,
    OrderByAction,
    SelectColumnAction,
    SelectTableAction,
)
from handlers.query_handler import DecisionModel, QueryAction, QueryState
from ml_adapters.ornith_adapter import OrnithDecisionAgent


class OrnithDecisionModel(DecisionModel):
    """
    Connects the OrnithDecisionAgent (LM Studio / OpenAI-compatible endpoint)
    to the traceable query execution platform's DecisionModel interface.

    Flow:
        1. Determine current query state & legal schema options.
        2. Format state & questions for OrnithDecisionAgent.
        3. Convert model answers and probabilities into a typed QueryAction with confidence.
    """

    def __init__(
        self,
        agent: OrnithDecisionAgent | None = None,
        *,
        model: str = "ornith-1.5",
        base_url: str = "http://localhost:1234/v1",
        api_key: str = "lm-studio",
        temperature: float = 0.0,
    ):
        self.agent = agent or OrnithDecisionAgent(
            model=model,
            base_url=base_url,
            api_key=api_key,
            temperature=temperature,
        )

    def decide(
        self,
        *,
        request: str,
        state: QueryState,
        environment: Any,
    ) -> QueryAction:
        schema = environment
        actions = state.actions

        # ------------------------------------------------------------------
        # 1. Base table selection (if not yet chosen)
        # ------------------------------------------------------------------
        active_tables = [
            getattr(a, "table")
            for a in actions
            if getattr(a, "action_type", "") in ("SELECT_TABLE", "JOIN")
        ]

        if not active_tables:
            table_options = [t.name for t in schema.tables] if schema and schema.tables else ["students"]
            criteria = {
                t: f"Query data from table '{t}'"
                for t in table_options
            }

            resp = self.agent.predict(
                state=f"User Goal: {request}\nCurrent Stage: No table selected yet.",
                questions={
                    "table": {
                        "type": "choice",
                        "instructions": "Which base database table should be queried first?",
                        "criteria": criteria,
                    }
                },
            )
            ans = resp.get("answers", {}).get("table", {})
            choice = ans.get("choice") or table_options[0]
            conf = float(ans.get("answer_confidence", 1.0))
            return SelectTableAction(table=choice, confidence=conf)

        # ------------------------------------------------------------------
        # 2. Next operation selection
        # ------------------------------------------------------------------
        # Legal operations based on existing actions:
        has_columns = any(getattr(a, "action_type", "") == "SELECT_COLUMN" for a in actions)
        has_limit = any(getattr(a, "action_type", "") == "LIMIT" for a in actions)

        operation_criteria = {
            "select_column": "Specify columns to output in the result",
            "filter": "Add a WHERE condition to restrict rows",
            "join": "Join another related table",
            "order_by": "Sort the output rows",
            "finish": "Finish query construction",
        }
        if not has_limit:
            operation_criteria["limit"] = "Restrict the number of rows returned"

        existing_actions_summary = ", ".join(
            f"{a.action_type}({getattr(a, 'column', getattr(a, 'table', ''))})"
            for a in actions
        )

        state_summary = (
            f"User Goal: {request}\n"
            f"Active Tables: {', '.join(active_tables)}\n"
            f"Existing Actions: {existing_actions_summary}\n"
            f"Current SQL: {state.sql or 'None'}"
        )

        resp = self.agent.predict(
            state=state_summary,
            questions={
                "operation": {
                    "type": "choice",
                    "instructions": "What is the next database operation to apply?",
                    "criteria": operation_criteria,
                }
            },
        )
        op_ans = resp.get("answers", {}).get("operation", {})
        op_choice = op_ans.get("choice", "finish")
        op_conf = float(op_ans.get("answer_confidence", 1.0))

        # ------------------------------------------------------------------
        # 3. Parameterize the selected action
        # ------------------------------------------------------------------
        available_columns: list[str] = []
        if schema:
            for t_name in active_tables:
                t = schema.table(t_name)
                if t:
                    available_columns.extend(c.name for c in t.columns)
        if not available_columns:
            available_columns = ["id", "name"]

        if op_choice == "select_column":
            col_criteria = {c: f"Include column {c}" for c in available_columns}
            col_criteria["*"] = "Include all columns (*)"
            c_resp = self.agent.predict(
                state=state_summary,
                questions={
                    "column": {
                        "type": "choice",
                        "instructions": "Which column should be selected?",
                        "criteria": col_criteria,
                    }
                },
            )
            col_ans = c_resp.get("answers", {}).get("column", {})
            col = col_ans.get("choice") or available_columns[0]
            conf = min(op_conf, float(col_ans.get("answer_confidence", 1.0)))
            return SelectColumnAction(column=col, confidence=conf)

        elif op_choice == "filter":
            col_criteria = {c: f"Filter condition on {c}" for c in available_columns}
            f_resp = self.agent.predict(
                state=state_summary,
                questions={
                    "column": {
                        "type": "choice",
                        "instructions": "Which column should the filter condition apply to?",
                        "criteria": col_criteria,
                    },
                    "operator": {
                        "type": "choice",
                        "instructions": "Which operator?",
                        "criteria": {
                            "=": "Equal to",
                            "!=": "Not equal to",
                            ">": "Greater than",
                            ">=": "Greater than or equal to",
                            "<": "Less than",
                            "<=": "Less than or equal to",
                            "LIKE": "Matches text pattern",
                        },
                    },
                },
            )
            f_answers = f_resp.get("answers", {})
            f_col = f_answers.get("column", {}).get("choice") or available_columns[0]
            f_op = f_answers.get("operator", {}).get("choice") or "="
            conf = min(op_conf, float(f_answers.get("column", {}).get("answer_confidence", 1.0)))

            # Extract filter value using completion
            prompt = (
                f"Given the user goal: '{request}', what value is compared against "
                f"column '{f_col}' with operator '{f_op}'? Return ONLY valid JSON: {{\"value\": ...}}"
            )
            raw = self.agent._complete(prompt)
            parsed = self.agent._parse_json(raw)
            val = parsed.get("value", 0)

            return FilterAction(column=f_col, operator=f_op, value=val, confidence=conf)

        elif op_choice == "order_by":
            col_criteria = {c: f"Order by {c}" for c in available_columns}
            o_resp = self.agent.predict(
                state=state_summary,
                questions={
                    "column": {
                        "type": "choice",
                        "instructions": "Which column should be used for sorting?",
                        "criteria": col_criteria,
                    },
                    "direction": {
                        "type": "choice",
                        "instructions": "Sorting direction?",
                        "criteria": {
                            "ASC": "Ascending order (low to high)",
                            "DESC": "Descending order (high to low)",
                        },
                    },
                },
            )
            o_answers = o_resp.get("answers", {})
            col = o_answers.get("column", {}).get("choice") or available_columns[0]
            direction = o_answers.get("direction", {}).get("choice") or "ASC"
            conf = min(op_conf, float(o_answers.get("column", {}).get("answer_confidence", 1.0)))
            return OrderByAction(column=col, direction=direction, confidence=conf)

        elif op_choice == "join":
            # Find candidate join tables
            all_tables = [t.name for t in schema.tables] if schema else []
            candidate_tables = [t for t in all_tables if t not in active_tables]
            if candidate_tables and schema:
                # Find relationships
                rel_criteria = {
                    t: f"Join with table {t}" for t in candidate_tables
                }
                j_resp = self.agent.predict(
                    state=state_summary,
                    questions={
                        "join_table": {
                            "type": "choice",
                            "instructions": "Which table to join?",
                            "criteria": rel_criteria,
                        }
                    },
                )
                j_table = j_resp.get("answers", {}).get("join_table", {}).get("choice") or candidate_tables[0]
                conf = min(op_conf, float(j_resp.get("answers", {}).get("join_table", {}).get("answer_confidence", 1.0)))
                # Resolve join key
                left_key, right_key = "id", "id"
                for src, fk in schema.relationships():
                    if (src in active_tables and fk.referenced_table == j_table):
                        left_key, right_key = fk.column, fk.referenced_column
                        break
                    elif (src == j_table and fk.referenced_table in active_tables):
                        left_key, right_key = fk.referenced_column, fk.column
                        break
                return JoinAction(table=j_table, left_on=left_key, right_on=right_key, confidence=conf)

        elif op_choice == "limit":
            return LimitAction(limit=10, confidence=op_conf)

        # Default fallback is finish
        return FinishAction(confidence=op_conf)
