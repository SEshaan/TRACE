from __future__ import annotations

from typing import Any
from handlers.actions import (
    AggregateAction,
    AbortQueryAction,
    FilterAction,
    FinishAction,
    InsufficientInfoAction,
    JoinAction,
    LimitAction,
    OrderByAction,
    SchemaMissingAction,
    SelectColumnAction,
    SelectTableAction,
)
from handlers.query_handler import DecisionModel, QueryAction, QueryState
from ml_adapters.ornith_adapter import OrnithDecisionAgent


_GRACEFUL_CHOICES = {
    "insufficient_info": (
        "The request is ambiguous or omits a value needed to build the query; "
        "ask for clarification instead of guessing."
    ),
    "schema_missing": (
        "The request requires a table, column, or relationship absent from the "
        "available database schema."
    ),
    "abort_query": (
        "LAST RESORT: the request cannot be satisfied at all; use only when no "
        "valid query or recoverable clarification/schema response is possible."
    ),
}


def _with_graceful_choices(criteria: dict[str, str]) -> dict[str, str]:
    return {**criteria, **_GRACEFUL_CHOICES}


def _graceful_choice(answer: dict[str, Any]) -> str | None:
    choice = answer.get("choice")
    return choice if choice in _GRACEFUL_CHOICES else None


def _summarize_schema(schema: Any) -> str:
    """
    Compact text summary of the available schema, used to help the model
    identify which table/column/relationship a request cannot satisfy.
    """

    if not schema or not getattr(schema, "tables", None):
        return "No database schema is available."

    lines = []
    for t in schema.tables:
        cols = ", ".join(c.name for c in t.columns)
        rels = ", ".join(f"{fk.referenced_table}.{fk.referenced_column}" for fk in getattr(t, "foreign_keys", []) or [])
        suffix = f" (FK -> {rels})" if rels else ""
        lines.append(f"- {t.name}({cols}){suffix}")
    return "\n".join(lines)


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

    def _make_graceful_action(
        self,
        choice: str,
        *,
        request: str,
        state_summary: str,
        schema_summary: str,
        confidence: float,
    ) -> QueryAction:
        if choice == "insufficient_info":
            prompt = (
                f"The user asked: '{request}'.\nCurrent query state:\n{state_summary}\n\n"
                "The request cannot be completed without guessing a missing or "
                "ambiguous fact. State why, and ask one concise clarification. "
                'Return ONLY valid JSON: {"reason": "...", "clarification": "..."}'
            )
            parsed = self.agent._parse_json(self.agent._complete(prompt))
            reason = str(parsed.get("reason", "Insufficient information to complete the query")).strip()
            clarification = parsed.get("clarification")
            return InsufficientInfoAction(
                reason=reason,
                clarification=str(clarification) if clarification else None,
                confidence=confidence,
            )

        if choice == "schema_missing":
            prompt = (
                f"The user asked: '{request}'.\nAvailable database schema:\n{schema_summary}\n\n"
                "Identify the required table, column, or relationship that is "
                "absent. Do not invent schema objects. "
                'Return ONLY valid JSON: {"reason": "...", "table": "...", '
                '"column": "...", "expected_relationship": "..."}'
            )
            parsed = self.agent._parse_json(self.agent._complete(prompt))

            def optional_text(value: Any) -> str | None:
                return str(value).strip() if value else None

            return SchemaMissingAction(
                reason=str(parsed.get("reason", "Required schema object is missing in the database")).strip(),
                table=optional_text(parsed.get("table")),
                column=optional_text(parsed.get("column")),
                expected_relationship=optional_text(parsed.get("expected_relationship")),
                confidence=confidence,
            )

        prompt = (
            f"The user asked: '{request}'.\nCurrent query state:\n{state_summary}\n\n"
            "Explain briefly why no valid query can satisfy this request. "
            'Return ONLY valid JSON: {"reason": "..."}'
        )
        parsed = self.agent._parse_json(self.agent._complete(prompt))
        return AbortQueryAction(
            reason=str(parsed.get("reason", "Unable to satisfy the request")).strip(),
            confidence=confidence,
        )

    def decide(
        self,
        *,
        request: str,
        state: QueryState,
        environment: Any,
        graph_context: dict | None = None,
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
            criteria = _with_graceful_choices(criteria)

            resp = self.agent.predict(
                state=f"User Goal: {request}\nCurrent Stage: No table selected yet.",
                questions={
                    "table": {
                        "type": "choice",
                        "instructions": (
                            "Which base database table should be queried first? "
                            "Do not guess when the request is ambiguous or the schema "
                            "cannot satisfy it; choose the matching graceful-fail option."
                        ),
                        "criteria": criteria,
                    }
                },
            )
            ans = resp.get("answers", {}).get("table", {})
            choice = ans.get("choice") or table_options[0]
            conf = float(ans.get("answer_confidence", 1.0))

            failure_choice = _graceful_choice(ans)
            if failure_choice:
                return self._make_graceful_action(
                    failure_choice,
                    request=request,
                    state_summary=f"User Goal: {request}\nNo table selected yet.",
                    schema_summary=_summarize_schema(schema),
                    confidence=conf,
                )

            return SelectTableAction(table=choice, confidence=conf)

        # ------------------------------------------------------------------
        # 2. Next operation selection
        # ------------------------------------------------------------------
        # Legal operations based on existing actions:
        has_limit = any(getattr(a, "action_type", "") == "LIMIT" for a in actions)

        operation_criteria = {
            "select_column": "Specify columns to output in the result",
            "filter": "Add a WHERE condition to restrict rows",
            "join": "Join another related table",
            "aggregate": "Calculate a COUNT, SUM, AVG, MIN, or MAX summary",
            "order_by": "Sort the output rows",
            "finish": "Finish query construction",
        }
        if not has_limit:
            operation_criteria["limit"] = "Restrict the number of rows returned"

        # ------------------------------------------------------------------
        # Graceful failure options.
        # Offer these when the request cannot be built with what we have.
        # Soft fails (insufficient_info / schema_missing) are recoverable by
        # branching from an earlier checkpoint; abort_query is a hard terminal
        # fail reserved for genuine dead-ends at/near the root state.
        # ------------------------------------------------------------------
        operation_criteria = _with_graceful_choices(operation_criteria)

        existing_actions_summary = ", ".join(
            f"{a.action_type}({getattr(a, 'column', getattr(a, 'table', ''))})"
            for a in actions
        )

        schema_summary = _summarize_schema(schema)

        # Graph context: avoid repeating rejected work on sibling branches and
        # after backtracking from a checkpoint.
        graph_note = ""
        if graph_context:
            siblings = graph_context.get("sibling_actions") or {}
            if siblings:
                tried = ", ".join(
                    f"depth {d}: {', '.join(types)}"
                    for d, types in sorted(siblings.items())
                )
                graph_note += f"Already Tried (abandoned branches): {tried}\n"
            if graph_context.get("is_recovered_branch"):
                graph_note += "You are on a branch recovered from an earlier checkpoint.\n"
            failures = graph_context.get("recent_failures") or []
            if failures:
                failed = ", ".join(
                    f"{f['action_type']} ({f['code']})"
                    for f in failures
                )
                graph_note += f"Recently Rejected: {failed}\n"

        state_summary = (
            f"User Goal: {request}\n"
            f"Active Tables: {', '.join(active_tables)}\n"
            f"Existing Actions: {existing_actions_summary}\n"
            f"Current SQL: {state.sql or 'None'}\n"
            f"Available Schema:\n{schema_summary}"
            + (f"\nGraph Context:\n{graph_note}" if graph_note else "")
        )

        resp = self.agent.predict(
            state=state_summary,
            questions={
                "operation": {
                    "type": "choice",
                    "instructions": (
                        "What is the next database operation to apply? If required "
                        "information is missing or the schema cannot satisfy the "
                        "request, choose its graceful-fail option instead of guessing."
                    ),
                    "criteria": operation_criteria,
                }
            },
        )
        op_ans = resp.get("answers", {}).get("operation", {})
        op_choice = op_ans.get("choice", "finish")
        op_conf = float(op_ans.get("answer_confidence", 1.0))
        failure_choice = _graceful_choice(op_ans)
        if failure_choice:
            return self._make_graceful_action(
                failure_choice,
                request=request,
                state_summary=state_summary,
                schema_summary=schema_summary,
                confidence=op_conf,
            )

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
                        "instructions": "Which column should be selected? If no requested column exists, choose schema_missing.",
                        "criteria": _with_graceful_choices(col_criteria),
                    }
                },
            )
            col_ans = c_resp.get("answers", {}).get("column", {})
            failure_choice = _graceful_choice(col_ans)
            if failure_choice:
                return self._make_graceful_action(
                    failure_choice,
                    request=request,
                    state_summary=state_summary,
                    schema_summary=schema_summary,
                    confidence=min(op_conf, float(col_ans.get("answer_confidence", 1.0))),
                )
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
                        "instructions": "Which column should the filter condition apply to? If the requested column is absent, choose schema_missing.",
                        "criteria": _with_graceful_choices(col_criteria),
                    },
                    "operator": {
                        "type": "choice",
                        "instructions": "Which operator? Do not infer an ambiguous condition; choose insufficient_info if clarification is needed.",
                        "criteria": _with_graceful_choices({
                            "=": "Equal to",
                            "!=": "Not equal to",
                            ">": "Greater than",
                            ">=": "Greater than or equal to",
                            "<": "Less than",
                            "<=": "Less than or equal to",
                            "LIKE": "Matches text pattern",
                        }),
                    },
                },
            )
            f_answers = f_resp.get("answers", {})
            failure_answer = next(
                (answer for answer in f_answers.values() if _graceful_choice(answer)),
                None,
            )
            if failure_answer:
                return self._make_graceful_action(
                    _graceful_choice(failure_answer),
                    request=request,
                    state_summary=state_summary,
                    schema_summary=schema_summary,
                    confidence=min(op_conf, float(failure_answer.get("answer_confidence", 1.0))),
                )
            f_col = f_answers.get("column", {}).get("choice") or available_columns[0]
            f_op = f_answers.get("operator", {}).get("choice") or "="
            conf = min(op_conf, float(f_answers.get("column", {}).get("answer_confidence", 1.0)))

            # Extract filter value using completion
            prompt = (
                f"Given the user goal: '{request}', what value is compared against "
                f"column '{f_col}' with operator '{f_op}'? If the request does not "
                "specify a value, do not guess; return "
                'ONLY valid JSON: {"value": ...} or {"insufficient_info": true}.'
            )
            raw = self.agent._complete(prompt)
            parsed = self.agent._parse_json(raw)
            if "value" not in parsed or parsed.get("insufficient_info") is True:
                return self._make_graceful_action(
                    "insufficient_info",
                    request=request,
                    state_summary=state_summary,
                    schema_summary=schema_summary,
                    confidence=op_conf,
                )
            val = parsed["value"]

            return FilterAction(column=f_col, operator=f_op, value=val, confidence=conf)

        elif op_choice == "order_by":
            col_criteria = {c: f"Order by {c}" for c in available_columns}
            o_resp = self.agent.predict(
                state=state_summary,
                questions={
                    "column": {
                        "type": "choice",
                        "instructions": "Which column should be used for sorting? If the requested column is absent, choose schema_missing.",
                        "criteria": _with_graceful_choices(col_criteria),
                    },
                    "direction": {
                        "type": "choice",
                        "instructions": "Sorting direction?",
                        "criteria": _with_graceful_choices({
                            "ASC": "Ascending order (low to high)",
                            "DESC": "Descending order (high to low)",
                        }),
                    },
                },
            )
            o_answers = o_resp.get("answers", {})
            failure_answer = next(
                (answer for answer in o_answers.values() if _graceful_choice(answer)),
                None,
            )
            if failure_answer:
                return self._make_graceful_action(
                    _graceful_choice(failure_answer),
                    request=request,
                    state_summary=state_summary,
                    schema_summary=schema_summary,
                    confidence=min(op_conf, float(failure_answer.get("answer_confidence", 1.0))),
                )
            col = o_answers.get("column", {}).get("choice") or available_columns[0]
            direction = o_answers.get("direction", {}).get("choice") or "ASC"
            conf = min(op_conf, float(o_answers.get("column", {}).get("answer_confidence", 1.0)))
            return OrderByAction(column=col, direction=direction, confidence=conf)

        elif op_choice == "aggregate":
            aggregate_resp = self.agent.predict(
                state=state_summary,
                questions={
                    "function": {
                        "type": "choice",
                        "instructions": "Which aggregate should be calculated?",
                        "criteria": _with_graceful_choices({
                            "COUNT": "Count rows or non-null values",
                            "SUM": "Sum numeric values",
                            "AVG": "Calculate the numeric average",
                            "MIN": "Find the minimum value",
                            "MAX": "Find the maximum value",
                        }),
                    }
                },
            )
            aggregate_answers = aggregate_resp.get("answers", {})
            function_answer = aggregate_answers.get("function", {})
            failure_choice = _graceful_choice(function_answer)
            if failure_choice:
                return self._make_graceful_action(
                    failure_choice,
                    request=request,
                    state_summary=state_summary,
                    schema_summary=schema_summary,
                    confidence=min(op_conf, float(function_answer.get("answer_confidence", 1.0))),
                )
            function = function_answer.get("choice", "COUNT")
            if function not in {"COUNT", "SUM", "AVG", "MIN", "MAX"}:
                return self._make_graceful_action(
                    "insufficient_info",
                    request=request,
                    state_summary=state_summary,
                    schema_summary=schema_summary,
                    confidence=op_conf,
                )

            aggregate_columns = (
                [*available_columns, "*"] if function == "COUNT" else available_columns
            )
            column_resp = self.agent.predict(
                state=state_summary,
                questions={
                    "column": {
                        "type": "choice",
                        "instructions": "Which column should be aggregated?",
                        "criteria": _with_graceful_choices({
                            column: (
                                "Count all rows"
                                if column == "*"
                                else f"Apply {function} to {column}"
                            )
                            for column in aggregate_columns
                        }),
                    }
                },
            )
            column_answers = column_resp.get("answers", {})
            column_answer = column_answers.get("column", {})
            failure_choice = _graceful_choice(column_answer)
            if failure_choice:
                return self._make_graceful_action(
                    failure_choice,
                    request=request,
                    state_summary=state_summary,
                    schema_summary=schema_summary,
                    confidence=min(
                        op_conf,
                        float(function_answer.get("answer_confidence", 1.0)),
                        float(column_answer.get("answer_confidence", 1.0)),
                    ),
                )
            column = column_answer.get("choice") or aggregate_columns[0]
            confidence = min(
                op_conf,
                float(function_answer.get("answer_confidence", 1.0)),
                float(column_answer.get("answer_confidence", 1.0)),
            )
            return AggregateAction(
                function=function,
                column=column,
                confidence=confidence,
            )

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
                            "instructions": "Which table should be joined? If no requested table or relationship exists, choose schema_missing.",
                            "criteria": _with_graceful_choices(rel_criteria),
                        }
                    },
                )
                j_answer = j_resp.get("answers", {}).get("join_table", {})
                failure_choice = _graceful_choice(j_answer)
                confidence = min(op_conf, float(j_answer.get("answer_confidence", 1.0)))
                if failure_choice:
                    return self._make_graceful_action(
                        failure_choice,
                        request=request,
                        state_summary=state_summary,
                        schema_summary=schema_summary,
                        confidence=confidence,
                    )
                j_table = j_answer.get("choice") or candidate_tables[0]
                conf = confidence
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
            return self._make_graceful_action(
                "schema_missing",
                request=request,
                state_summary=state_summary,
                schema_summary=schema_summary,
                confidence=op_conf,
            )

        elif op_choice == "limit":
            return LimitAction(limit=10, confidence=op_conf)

        # Default fallback is finish
        return FinishAction(confidence=op_conf)
