"""
Laya-like decision adapter for LM Studio + Ornith-1.5.

LM Studio:
    http://localhost:1234/v1

The adapter accepts the same general structure as Laya:

    state = "Find students from the CSE department who scored more than 85 in DBMS."

    questions = {
        "action": {
            "type": "choice",
            "instructions": "What is the primary query operation?",
            "criteria": {
                "filter": "Restrict rows using conditions",
                "join": "Combine multiple tables",
                "aggregate": "Calculate a summary",
                "order": "Sort the results"
            }
        }
    }

and returns:

    {
        "model": "ornith-1.5",
        "answers": {
            "action": {
                "type": "choice",
                "choice": "filter",
                "probabilities": {...},
                "answer_confidence": 0.87
            }
        }
    }
"""

from __future__ import annotations

import json
import re
from typing import Any

from openai import OpenAI


class OrnithDecisionAgent:
    """
    Laya-like adapter around an OpenAI-compatible LM Studio endpoint.

    Important:
        This is an autoregressive model producing structured decisions.
        It is API-compatible in spirit with Laya, not architecturally equivalent.
    """

    def __init__(
        self,
        model: str = "ornith-1.5",
        base_url: str = "http://localhost:1234/v1",
        api_key: str = "lm-studio",
        temperature: float = 0.0,
        max_tokens: int = 512,
    ):
        self.model = model
        self.temperature = temperature
        self.max_tokens = max_tokens

        self.client = OpenAI(
            base_url=base_url,
            api_key=api_key,
        )

    def predict(
        self,
        state: str,
        questions: dict[str, dict[str, Any]],
    ) -> dict[str, Any]:

        answers = {}

        for name, question in questions.items():
            answers[name] = self._predict_question(
                state=state,
                question_name=name,
                question=question,
            )

        return {
            "model": self.model,
            "answers": answers,
        }

    def _predict_question(
        self,
        state: str,
        question_name: str,
        question: dict[str, Any],
    ) -> dict[str, Any]:

        qtype = question.get("type")

        if qtype == "choice":
            return self._choice(
                state,
                question_name,
                question,
            )

        if qtype == "score":
            return self._score(
                state,
                question_name,
                question,
            )

        if qtype == "noul":
            return self._noul(
                state,
                question_name,
                question,
            )

        raise ValueError(
            f"Unsupported question type: {qtype!r}"
        )

    # ------------------------------------------------------------------
    # CHOICE
    # ------------------------------------------------------------------

    def _choice(
        self,
        state: str,
        question_name: str,
        question: dict[str, Any],
    ) -> dict[str, Any]:

        criteria = question["criteria"]

        # Allow both:
        #
        # {"filter": "Restrict rows..."}
        #
        # and:
        #
        # ["filter", "join", "aggregate"]

        if isinstance(criteria, dict):
            options = list(criteria.keys())
            descriptions = criteria
        elif isinstance(criteria, list):
            options = criteria
            descriptions = {
                option: option
                for option in options
            }
        else:
            raise TypeError(
                f"Invalid criteria for {question_name}"
            )

        option_text = "\n".join(
            f"- {option}: {descriptions[option]}"
            for option in options
        )

        schema = {
            "choice": "one of the option keys",
            "probabilities": {
                option: "number between 0 and 1"
                for option in options
            },
        }

        prompt = f"""
You are a deterministic decision component inside a database query system.

Do NOT generate SQL.
Do NOT explain your reasoning.
Do NOT add any options that are not provided.

Given the user state, select exactly ONE option.

STATE:
{state}

DECISION:
{question["instructions"]}

OPTIONS:
{option_text}

Return ONLY valid JSON matching this schema:

{json.dumps(schema, indent=2)}

The probability values should represent your relative belief over the
provided options and should sum to approximately 1.
"""

        raw = self._complete(prompt)

        result = self._parse_json(raw)

        choice = result.get("choice")

        if choice not in options:
            choice = self._fallback_choice(
                result,
                options,
            )

        probabilities = self._normalise_probabilities(
            result.get("probabilities", {}),
            options,
        )

        confidence = probabilities.get(choice, 0.0) if choice is not None else 0.0


        return {
            "type": "choice",
            "choice": choice,
            "probabilities": probabilities,
            "answer_confidence": confidence,
            "raw": raw,
        }

    # ------------------------------------------------------------------
    # YES / NO
    # ------------------------------------------------------------------

    def _noul(
        self,
        state: str,
        question_name: str,
        question: dict[str, Any],
    ) -> dict[str, Any]:

        prompt = f"""
You are a decision component in a SQL generation system.

STATE:
{state}

QUESTION:
{question["instructions"]}

Return ONLY JSON:

{{
  "answer": "yes" or "no",
  "probabilities": {{
    "yes": 0.0,
    "no": 0.0
  }}
}}
"""

        raw = self._complete(prompt)
        result = self._parse_json(raw)

        answer = result.get("answer", "").lower()

        if answer not in ("yes", "no"):
            answer = "yes"

        probabilities = self._normalise_probabilities(
            result.get("probabilities", {}),
            ["yes", "no"],
        )

        return {
            "type": "noul",
            "choice": answer,
            "probabilities": probabilities,
            "answer_confidence": probabilities[answer],
            "raw": raw,
        }

    # ------------------------------------------------------------------
    # SCORE
    # ------------------------------------------------------------------

    def _score(
        self,
        state: str,
        question_name: str,
        question: dict[str, Any],
    ) -> dict[str, Any]:

        prompt = f"""
You are a scoring component in a SQL generation system.

STATE:
{state}

QUESTION:
{question["instructions"]}

Return ONLY JSON:

{{
  "score": 0.0
}}

The score must be between 0 and 2.
"""

        raw = self._complete(prompt)
        result = self._parse_json(raw)

        try:
            score = float(result["score"])
        except (KeyError, TypeError, ValueError):
            score = 0.0

        score = max(0.0, min(2.0, score))

        return {
            "type": "score",
            "score": score,
            "raw": raw,
        }

    # ------------------------------------------------------------------
    # LM STUDIO
    # ------------------------------------------------------------------

    def _complete(self, prompt: str) -> str:

        response = self.client.chat.completions.create(
            model=self.model,
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You are a structured decision engine. "
                        "Output JSON only."
                    ),
                },
                {
                    "role": "user",
                    "content": prompt,
                },
            ],
            temperature=self.temperature,
            max_tokens=self.max_tokens,
        )

        return response.choices[0].message.content or ""

    # ------------------------------------------------------------------
    # JSON
    # ------------------------------------------------------------------

    @staticmethod
    def _parse_json(text: str) -> dict[str, Any]:

        text = text.strip()

        # Remove markdown fences if the model ignored the instruction.
        text = re.sub(
            r"^```(?:json)?\s*",
            "",
            text,
            flags=re.IGNORECASE,
        )

        text = re.sub(
            r"\s*```$",
            "",
            text,
        )

        try:
            value = json.loads(text)

            if isinstance(value, dict):
                return value

        except json.JSONDecodeError:
            pass

        # Last-resort extraction of the first JSON object.
        match = re.search(
            r"\{.*\}",
            text,
            flags=re.DOTALL,
        )

        if match:
            try:
                value = json.loads(match.group(0))

                if isinstance(value, dict):
                    return value

            except json.JSONDecodeError:
                pass

        return {}

    @staticmethod
    def _normalise_probabilities(
        probabilities: dict[str, Any],
        options: list[str],
    ) -> dict[str, float]:

        values = {}

        for option in options:
            try:
                value = float(probabilities.get(option, 0.0))
            except (TypeError, ValueError):
                value = 0.0

            values[option] = max(0.0, value)

        total = sum(values.values())

        if total <= 0:
            uniform = 1.0 / len(options)

            return {
                option: uniform
                for option in options
            }

        return {
            option: value / total
            for option, value in values.items()
        }

    @staticmethod
    def _fallback_choice(
        result: dict[str, Any],
        options: list[str],
    ) -> str:

        probabilities = result.get(
            "probabilities",
            {},
        )

        valid = {
            option: float(probabilities.get(option, 0.0))
            for option in options
            if option in probabilities
        }


        if valid:
            return max(valid, key=lambda option: valid[option])

        # If the model returned something unusable,
        # fail deterministically rather than hallucinating.
        return options[0]


# ----------------------------------------------------------------------
# EXAMPLE
# ----------------------------------------------------------------------

if __name__ == "__main__":

    agent = OrnithDecisionAgent(
        model="ornith-1.5",
        base_url="http://localhost:1234/v1",
        temperature=0.0,
    )

    state = (
        "Find students from the CSE department "
        "who scored more than 85 in DBMS."
    )

    questions = {
        "action": {
            "type": "choice",
            "instructions": "What is the primary query operation?",
            "criteria": {
                "filter": "Restrict rows using conditions",
                "join": "Combine multiple tables",
                "aggregate": "Calculate a summary",
                "order": "Sort the results",
            },
        }
    }

    result = agent.predict(
        state,
        questions,
    )

    print(json.dumps(
        result,
        indent=2,
    ))
