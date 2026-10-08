from __future__ import annotations

import json
import re
from typing import Any
from handlers.actions import (
    AggregateAction,
    AbortQueryAction,
    FilterAction,
    FinishAction,
    GroupByAction,
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

_GROUPED_AGGREGATION_RE = re.compile(
    r"\b(?:count(?:ing)?|number of|how many|sum|total|average|avg|minimum|min|maximum|max)\b"
    r".{0,100}\b(?:by|per|each|every)\b",
    re.IGNORECASE,
)
_ORDERING_INTENT_RE = re.compile(
    r"\b(?:order(?:ed)?|sort(?:ed)?|highest|lowest|top|bottom|most|fewest|"
    r"largest|smallest|greatest|least|first|last)\b",
    re.IGNORECASE,
)
_LIMIT_INTENT_RE = re.compile(
    r"\b(?:top|bottom|first|last|limit|at most|no more than|most|fewest)\b"
    r"|\b\d+\s+(?:results?|rows?|records?)\b",
    re.IGNORECASE,
)
_AGGREGATE_RANKING_RE = re.compile(
    r"\b(?:most|fewest|number of|count|total)\b(?!\s+recent)",
    re.IGNORECASE,
)
_COUNT_INTENT_RE = re.compile(
    r"\b(?:most|fewest|number of|count|how many)\b",
    re.IGNORECASE,
)


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


def _summarize_actions(actions: tuple[Any, ...]) -> str:
    """Serialize the complete ordered action history with its parameters."""
    summaries = []
    for action in actions:
        to_dict = getattr(action, "to_dict", None)
        values = to_dict() if callable(to_dict) else vars(action)
        summaries.append({
            key: value
            for key, value in values.items()
            if key not in {"confidence", "action_type"}
        } | {"action_type": action.action_type})
    return json.dumps(summaries, ensure_ascii=False, sort_keys=True, default=str)


def _column_options(schema: Any, active_tables: list[str]) -> dict[str, tuple[str, str | None]]:
    """Map model-visible column choices to unambiguous column/table references."""
    columns_by_table: dict[str, list[str]] = {}
    if schema:
        for table_name in dict.fromkeys(active_tables):
            table = schema.table(table_name)
            if table:
                columns_by_table[table_name] = [column.name for column in table.columns]

    if not columns_by_table:
        return {"id": ("id", None), "name": ("name", None)}

    table_counts: dict[str, int] = {}
    for columns in columns_by_table.values():
        for column in columns:
            table_counts[column] = table_counts.get(column, 0) + 1

    options = {}
    for table_name, columns in columns_by_table.items():
        for column in columns:
            label = f"{table_name}.{column}" if table_counts[column] > 1 else column
            options[label] = (column, table_name if table_counts[column] > 1 else None)
    return options


def _column_schema(
    schema: Any,
    active_tables: list[str],
    column: str,
    table_name: str | None,
) -> Any | None:
    table_names = [table_name] if table_name else active_tables
    for candidate_name in table_names:
        table = schema.table(candidate_name) if schema else None
        if table and (column_schema := table.column(column)) is not None:
            return column_schema
    return None


def _requests_grouped_aggregation(request: str) -> bool:
    return (
        _GROUPED_AGGREGATION_RE.search(request) is not None
        or re.search(
            r"\b(?:with|having|among)\s+(?:the\s+)?(?:most|fewest)\b",
            request,
            re.IGNORECASE,
        ) is not None
    )


def _requested_entity_tables(
    request: str,
    active_tables: list[str],
) -> list[str]:
    words = set(re.findall(r"[a-z]+(?:_[a-z]+)*", request.lower()))
    matched = []
    for table_name in active_tables:
        normalized = table_name.lower().replace("_", " ")
        name_parts = normalized.split()
        singular_parts = [
            part[:-3] + "y" if part.endswith("ies")
            else part[:-1] if part.endswith("s")
            else part
            for part in name_parts
        ]
        if normalized in request.lower() or any(part in words for part in singular_parts):
            matched.append(table_name)
    return matched


def _numeric_column(column: Any) -> bool:
    data_type = str(getattr(column, "data_type", "")).upper()
    return any(kind in data_type for kind in ("INT", "REAL", "FLOA", "DOUB", "NUM", "DEC"))


def _join_options(
    schema: Any,
    active_tables: list[str],
) -> dict[str, tuple[str, str, str]]:
    """Return only join choices backed by a declared FK to an active table."""
    options: dict[str, tuple[str, str, str]] = {}
    if not schema:
        return options

    active_set = set(active_tables)
    for source in schema.tables:
        source_name = source.name
        for foreign_key in getattr(source, "foreign_keys", []) or []:
            target_name = foreign_key.referenced_table
            if source_name in active_set and target_name not in active_set:
                left_table, left_column = source_name, foreign_key.column
                right_table, right_column = target_name, foreign_key.referenced_column
            elif target_name in active_set and source_name not in active_set:
                left_table, left_column = target_name, foreign_key.referenced_column
                right_table, right_column = source_name, foreign_key.column
            else:
                continue

            left_reference = f"{left_table}.{left_column}"
            label = (
                f"{left_reference} -> {right_table}.{right_column}"
            )
            options[label] = (right_table, left_reference, right_column)
    return options


def _aggregate_sort_options(
    actions: tuple[Any, ...],
) -> dict[str, tuple[str, str | None, str]]:
    """Map displayed aggregate outputs to the exact aggregate expression."""
    options: dict[str, tuple[str, str | None, str]] = {}
    for action in actions:
        if getattr(action, "action_type", "") != "AGGREGATE":
            continue
        function = str(getattr(action, "function", "")).upper()
        column = getattr(action, "column", None)
        table = getattr(action, "table", None)
        if not column or function not in {"COUNT", "SUM", "AVG", "MIN", "MAX"}:
            continue
        label = getattr(action, "alias", None) or (
            f"{function}({f'{table}.' if table else ''}{column})"
        )
        options[label] = (column, table, function)
    return options


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
            choice = ans.get("choice")
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

            if choice not in table_options:
                return self._make_graceful_action(
                    "insufficient_info",
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
        count_intent = _COUNT_INTENT_RE.search(request) is not None
        requested_count_tables = (
            _requested_entity_tables(
                request,
                [table.name for table in schema.tables],
            )
            if count_intent and schema
            else []
        )
        missing_count_tables = set(requested_count_tables) - set(active_tables)
        column_options = _column_options(schema, active_tables)
        available_columns = list(column_options)
        selected_columns_with_table = {
            (getattr(action, "table", None), getattr(action, "column", None))
            for action in actions
            if getattr(action, "action_type", "") == "SELECT_COLUMN"
        }
        selected_columns = {
            getattr(action, "column", None)
            for action in actions
            if getattr(action, "action_type", "") == "SELECT_COLUMN"
        }
        pending_select_columns = [
            label for label, (column, table) in column_options.items()
            if (table, column) not in selected_columns_with_table
        ]
        if "*" not in selected_columns:
            pending_select_columns.append("*")

        joins = _join_options(schema, active_tables)
        targeted_joins = {
            label: join
            for label, join in joins.items()
            if join[0] in missing_count_tables
        }
        requires_counted_table_join = bool(missing_count_tables and targeted_joins)
        if requires_counted_table_join:
            joins = targeted_joins
        grouped_columns = {
            (getattr(action, "table", None), getattr(action, "column", None))
            for action in actions
            if getattr(action, "action_type", "") == "GROUP_BY"
        }
        pending_group_columns = [
            label for label, (column, table) in column_options.items()
            if (table, column) not in grouped_columns
        ]
        aggregate_sort_options = _aggregate_sort_options(actions)
        requires_aggregate_sort = _AGGREGATE_RANKING_RE.search(request) is not None
        order_options: dict[str, tuple[str, str | None, str | None]] = {
            label: (column, table, None)
            for label, (column, table) in column_options.items()
        }
        order_options.update({
            label: (column, table, function)
            for label, (column, table, function) in aggregate_sort_options.items()
        })
        if requires_aggregate_sort:
            order_options = {
                label: (column, table, function)
                for label, (column, table, function) in aggregate_sort_options.items()
            }
        already_ordered = {
            (
                getattr(action, "column", None),
                getattr(action, "table", None),
                getattr(action, "aggregate_function", None),
            )
            for action in actions
            if getattr(action, "action_type", "") == "ORDER_BY"
        }
        pending_order_options = {
            label: option
            for label, option in order_options.items()
            if option not in already_ordered
        }

        operation_criteria: dict[str, str] = {}
        if pending_select_columns:
            operation_criteria["select_column"] = "Specify output columns not already selected"
        if available_columns:
            operation_criteria["filter"] = "Add a WHERE condition to restrict rows"
        if joins:
            operation_criteria["join"] = "Join a table using one of the declared foreign-key relationships"
        if pending_group_columns and not requires_counted_table_join:
            operation_criteria["group_by"] = (
                "Group rows by a column not already used for grouping"
            )
        if available_columns and not requires_counted_table_join:
            operation_criteria["aggregate"] = "Calculate a supported aggregate summary"
        if (
            _ORDERING_INTENT_RE.search(request)
            and pending_order_options
            and (not requires_aggregate_sort or aggregate_sort_options)
        ):
            operation_criteria["order_by"] = "Sort by a source column or an aggregate already calculated"
        has_ordering = any(
            getattr(action, "action_type", "") == "ORDER_BY"
            for action in actions
        )
        if (
            not has_limit
            and _LIMIT_INTENT_RE.search(request)
            and (not _ORDERING_INTENT_RE.search(request) or has_ordering)
        ):
            operation_criteria["limit"] = "Apply the row count requested by the user"
        operation_criteria["finish"] = "Finish query construction"

        # ------------------------------------------------------------------
        # Graceful failure options.
        # Offer these when the request cannot be built with what we have.
        # Soft fails (insufficient_info / schema_missing) are recoverable by
        # branching from an earlier checkpoint; abort_query is a hard terminal
        # fail reserved for genuine dead-ends at/near the root state.
        # ------------------------------------------------------------------
        operation_criteria = _with_graceful_choices(operation_criteria)

        existing_actions_summary = _summarize_actions(actions)

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
            failed_siblings = graph_context.get("failed_siblings") or []
            for failed in failed_siblings:
                graph_note += (
                    f"Failed sibling at depth {failed.get('depth')}: "
                    f"{failed.get('action_type')}("
                    f"{json.dumps(failed.get('parameters', {}), sort_keys=True)}) "
                    f"[{failed.get('code')}]: {failed.get('reason')}\n"
                )
            if graph_context.get("is_recovered_branch"):
                graph_note += "You are on a branch recovered from an earlier checkpoint.\n"
            failures = graph_context.get("recent_failures") or []
            if failures:
                failed = ", ".join(
                    f"{f['action_type']} ({f['code']}): {f.get('message', '')}"
                    for f in failures
                )
                graph_note += f"Recent failure reasons: {failed}\n"

        state_summary = (
            f"User Goal: {request}\n"
            f"Active Tables: {', '.join(active_tables)}\n"
            f"Already Applied Actions (complete ordered history): {existing_actions_summary}\n"
            f"Current SQL: {state.sql or 'None'}\n"
            "Continue from this cumulative query state. Choose only an operation "
            "that is still needed to satisfy the user goal. Do not repeat an "
            "operation with the same parameters; additional distinct operations "
            "of the same type may still be required. When failed sibling nodes "
            "are listed, account for each failure reason and change the plan "
            "instead of repeating the rejected action unchanged.\n"
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
                        "request, choose its graceful-fail option instead of guessing. "
                        "For requests such as 'count X by Y', 'per Y', or 'for each Y', "
                        "choose group_by on Y and then aggregate the requested measure. "
                        "GROUP_BY only specifies the grouping column; AGGREGATE only "
                        "specifies the function and aggregated column. Do not substitute "
                        "one action for the other."
                    ),
                    "criteria": operation_criteria,
                }
            },
        )
        op_ans = resp.get("answers", {}).get("operation", {})
        op_choice = op_ans.get("choice", "finish")
        has_group_by = any(
            getattr(action, "action_type", "") == "GROUP_BY"
            for action in actions
        )
        if requires_counted_table_join:
            op_choice = "join"
        elif not has_group_by and _requests_grouped_aggregation(request):
            op_choice = "group_by"
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
        def resolve_column_choice(answer: dict[str, Any]) -> tuple[str, str | None] | None:
            choice = answer.get("choice")
            if choice is None:
                return next(iter(column_options.values()), None)
            if choice == "*":
                return "*", None
            return column_options.get(str(choice))

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
            selected_column = resolve_column_choice(col_ans)
            if selected_column is None:
                return self._make_graceful_action(
                    "insufficient_info",
                    request=request,
                    state_summary=state_summary,
                    schema_summary=schema_summary,
                    confidence=op_conf,
                )
            col, table = selected_column
            conf = min(op_conf, float(col_ans.get("answer_confidence", 1.0)))
            return SelectColumnAction(column=col, table=table, confidence=conf)

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
            filter_answer = f_answers.get("column", {})
            selected_column = resolve_column_choice(filter_answer)
            if selected_column is None:
                return self._make_graceful_action(
                    "insufficient_info",
                    request=request,
                    state_summary=state_summary,
                    schema_summary=schema_summary,
                    confidence=op_conf,
                )
            f_col, f_table = selected_column
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

            return FilterAction(
                column=f_col,
                operator=f_op,
                value=val,
                table=f_table,
                confidence=conf,
            )

        elif op_choice == "order_by":
            col_criteria = {
                label: f"Sort by {label}"
                for label in pending_order_options
            }
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
            selected_order = pending_order_options.get(
                o_answers.get("column", {}).get("choice")
            )
            if selected_order is None:
                return self._make_graceful_action(
                    "insufficient_info",
                    request=request,
                    state_summary=state_summary,
                    schema_summary=schema_summary,
                    confidence=op_conf,
                )
            col, table, aggregate_function = selected_order
            direction = o_answers.get("direction", {}).get("choice") or "ASC"
            conf = min(op_conf, float(o_answers.get("column", {}).get("answer_confidence", 1.0)))
            return OrderByAction(
                column=col,
                direction=direction,
                table=table,
                aggregate_function=aggregate_function,
                confidence=conf,
            )

        elif op_choice == "group_by":
            col_criteria = {
                column: f"Group the results by {column}"
                for column in available_columns
            }
            group_resp = self.agent.predict(
                state=state_summary,
                questions={
                    "column": {
                        "type": "choice",
                        "instructions": (
                            "Which column defines the categories or groups? "
                            "Choose only the grouping column, not an aggregate function."
                        ),
                        "criteria": _with_graceful_choices(col_criteria),
                    }
                },
            )
            group_answers = group_resp.get("answers", {})
            group_answer = group_answers.get("column", {})
            failure_choice = _graceful_choice(group_answer)
            if failure_choice:
                return self._make_graceful_action(
                    failure_choice,
                    request=request,
                    state_summary=state_summary,
                    schema_summary=schema_summary,
                    confidence=min(
                        op_conf,
                        float(group_answer.get("answer_confidence", 1.0)),
                    ),
                )
            selected_column = resolve_column_choice(group_answer)
            if selected_column is None:
                return self._make_graceful_action(
                    "insufficient_info",
                    request=request,
                    state_summary=state_summary,
                    schema_summary=schema_summary,
                    confidence=op_conf,
                )
            column, table = selected_column
            confidence = min(
                op_conf,
                float(group_answer.get("answer_confidence", 1.0)),
            )
            return GroupByAction(column=column, table=table, confidence=confidence)

        elif op_choice == "aggregate":
            numeric_columns = [
                label
                for label, (column_name, table_name) in column_options.items()
                if _numeric_column(
                    _column_schema(schema, active_tables, column_name, table_name)
                )
            ] if schema else []
            aggregate_criteria = {
                "COUNT": "Count rows or non-null values",
                "MIN": "Find the minimum value",
                "MAX": "Find the maximum value",
            }
            if count_intent:
                aggregate_criteria = {
                    "COUNT": "Count instances of the entity requested by the user"
                }
            elif numeric_columns:
                aggregate_criteria.update({
                    "SUM": "Sum numeric values",
                    "AVG": "Calculate the numeric average",
                })
            aggregate_resp = self.agent.predict(
                state=state_summary,
                questions={
                    "function": {
                        "type": "choice",
                        "instructions": (
                            "Which aggregate is requested? SUM and AVG are only "
                            "available for numeric columns."
                        ),
                        "criteria": _with_graceful_choices(aggregate_criteria),
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
            if function not in aggregate_criteria:
                return self._make_graceful_action(
                    "insufficient_info",
                    request=request,
                    state_summary=state_summary,
                    schema_summary=schema_summary,
                    confidence=op_conf,
                )

            aggregate_columns = [
                label for label in available_columns
                if function in {"COUNT", "MIN", "MAX"}
                or (
                    schema is not None
                    and _numeric_column(_column_schema(
                        schema,
                        active_tables,
                        column_options[label][0],
                        column_options[label][1],
                    ))
                )
            ]
            if function == "COUNT":
                aggregate_columns.append("*")
                if count_intent:
                    requested_tables = _requested_entity_tables(request, active_tables)
                    requested_primary_keys = {
                        (table.name, column.name)
                        for table_name in requested_tables
                        if (table := schema.table(table_name)) is not None
                        for column in table.columns
                        if column.primary_key
                    } if schema else set()
                    if requested_primary_keys:
                        aggregate_columns = [
                            label
                            for label, (column_name, table_name) in column_options.items()
                            if any(
                                column_name == primary_key
                                and (table_name is None or table_name == primary_table)
                                for primary_table, primary_key in requested_primary_keys
                            )
                        ] + ["*"]
            aggregate_options = {
                option: column_options.get(option, (option, None))
                for option in aggregate_columns
            }
            aggregate_options["*"] = ("*", None) if function == "COUNT" else aggregate_options.get("*", ("*", None))
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
            selected_column = aggregate_options.get(column_answer.get("choice"))
            if selected_column is None:
                return self._make_graceful_action(
                    "insufficient_info",
                    request=request,
                    state_summary=state_summary,
                    schema_summary=schema_summary,
                    confidence=op_conf,
                )
            column, table = selected_column
            confidence = min(
                op_conf,
                float(function_answer.get("answer_confidence", 1.0)),
                float(column_answer.get("answer_confidence", 1.0)),
            )
            return AggregateAction(
                function=function,
                column=column,
                table=table,
                confidence=confidence,
            )

        elif op_choice == "join":
            if joins and schema:
                j_resp = self.agent.predict(
                    state=state_summary,
                    questions={
                        "join_relationship": {
                            "type": "choice",
                            "instructions": (
                                "Choose only a declared foreign-key relationship "
                                "that connects an active table to a new table."
                            ),
                            "criteria": _with_graceful_choices({
                                label: f"Join {target} through this foreign key"
                                for label, (target, _, _) in joins.items()
                            }),
                        }
                    },
                )
                j_answer = j_resp.get("answers", {}).get("join_relationship", {})
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
                relationship = joins.get(j_answer.get("choice"))
                if relationship is None:
                    return self._make_graceful_action(
                        "schema_missing",
                        request=request,
                        state_summary=state_summary,
                        schema_summary=schema_summary,
                        confidence=confidence,
                    )
                j_table, left_key, right_key = relationship
                return JoinAction(
                    table=j_table,
                    left_on=left_key,
                    right_on=right_key,
                    confidence=confidence,
                )
            return self._make_graceful_action(
                "schema_missing",
                request=request,
                state_summary=state_summary,
                schema_summary=schema_summary,
                confidence=op_conf,
            )

        elif op_choice == "limit":
            parsed = self.agent._parse_json(self.agent._complete(
                f"User request: {request!r}\n"
                "Extract the requested result count as a positive integer. "
                "For a singular 'most', 'highest', 'lowest', or similar top/bottom "
                "result, use 1. If no count is requested, return "
                '{"insufficient_info": true}. Return only JSON: {"limit": N}.'
            ))
            limit = parsed.get("limit")
            if isinstance(limit, bool) or not isinstance(limit, int) or limit <= 0:
                return InsufficientInfoAction(
                    reason="The requested result limit could not be determined.",
                    clarification="How many results should I return?",
                    confidence=op_conf,
                )
            return LimitAction(limit=limit, confidence=op_conf)

        # Default fallback is finish
        return FinishAction(confidence=op_conf)
