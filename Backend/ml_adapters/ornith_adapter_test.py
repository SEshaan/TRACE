"""Unit tests for OrnithDecisionAgent's pure helpers and decision paths.

The static helpers (``_parse_json``, ``_normalise_probabilities``,
``_fallback_choice``) are deterministic and need no live LM Studio endpoint, so
they are exercised directly. The choice/noul/score flows are covered by patching
the single network boundary (``_complete``) with canned model output.
"""

from __future__ import annotations

import json
import sys
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

_TEST_DIR = Path(__file__).resolve().parent
_WORKSPACE_ROOT = _TEST_DIR.parents[2]
if str(_WORKSPACE_ROOT) not in sys.path:
    sys.path.insert(0, str(_WORKSPACE_ROOT))

import pytest

from Backend.ml_adapters.ornith_adapter import OrnithDecisionAgent


# ---------------------------------------------------------------------------
# _parse_json
# ---------------------------------------------------------------------------

def test_parse_json_returns_valid_dict():
    assert OrnithDecisionAgent._parse_json('{"a": 1}') == {"a": 1}


def test_parse_json_strips_markdown_fences():
    text = '```json\n{"choice": "filter"}\n```\n'
    assert OrnithDecisionAgent._parse_json(text) == {"choice": "filter"}


def test_parse_json_tolerates_surrounding_whitespace():
    text = "\n   \n  {\"x\": true}  \n"
    assert OrnithDecisionAgent._parse_json(text) == {"x": True}


def test_parse_json_falls_back_to_first_object():
    text = "garbage preamble {\"choice\": \"join\"} trailing noise"
    assert OrnithDecisionAgent._parse_json(text) == {"choice": "join"}


def test_parse_json_returns_empty_on_garbage():
    assert OrnithDecisionAgent._parse_json("not json at all") == {}


def test_parse_json_returns_empty_for_non_dict_json():
    # A JSON list is valid but not a dict -> last-resort object search fails.
    assert OrnithDecisionAgent._parse_json("[1, 2, 3]") == {}


# ---------------------------------------------------------------------------
# _normalise_probabilities
# ---------------------------------------------------------------------------

def test_normalise_probabilities_scales_to_one():
    result = OrnithDecisionAgent._normalise_probabilities(
        {"filter": 0.7, "join": 0.3}, ["filter", "join"]
    )
    assert result == {"filter": 0.7, "join": 0.3}


def test_normalise_probabilities_uniform_when_all_zero():
    result = OrnithDecisionAgent._normalise_probabilities({}, ["a", "b"])
    assert result == {"a": 0.5, "b": 0.5}


def test_normalise_probabilities_clamps_negatives_and_defaults_missing():
    # -1 clamps to 0 -> total 0 -> uniform over the single option.
    one = OrnithDecisionAgent._normalise_probabilities(
        {"filter": -1.0}, ["filter"]
    )
    assert one == {"filter": 1.0}

    # Missing "filter" defaults to 0; only "join" carries weight.
    two = OrnithDecisionAgent._normalise_probabilities(
        {"join": 0.5}, ["filter", "join"]
    )
    assert two == {"filter": 0.0, "join": 1.0}


def test_normalise_probabilities_ignores_non_numeric():
    result = OrnithDecisionAgent._normalise_probabilities(
        {"filter": "oops"}, ["filter", "join"]
    )
    assert result == {"filter": 0.5, "join": 0.5}


# ---------------------------------------------------------------------------
# _fallback_choice
# ---------------------------------------------------------------------------

def test_fallback_choice_picks_highest_probability():
    result = OrnithDecisionAgent._fallback_choice(
        {"probabilities": {"filter": 0.7, "join": 0.3}}, ["filter", "join"]
    )
    assert result == "filter"


def test_fallback_choice_returns_first_when_no_valid_option():
    # Neither option appears in the model's probabilities -> options[0].
    result = OrnithDecisionAgent._fallback_choice(
        {"probabilities": {"order": 0.9}}, ["filter", "join"]
    )
    assert result == "filter"


def test_fallback_choice_returns_first_without_probabilities():
    result = OrnithDecisionAgent._fallback_choice({}, ["filter", "join"])
    assert result == "filter"


# ---------------------------------------------------------------------------
# Decision flows (network boundary ``_complete`` mocked)
# ---------------------------------------------------------------------------

@contextmanager
def _mocked_ornith(complete_output: str) -> Iterator[OrnithDecisionAgent]:
    """Yield an OrnithDecisionAgent whose ``_complete`` returns canned output.

    The patch stays active for the whole ``with`` block, so every call to
    ``agent.predict(...)`` inside it is served by the mocked endpoint instead of
    a live LM Studio request.
    """
    agent = OrnithDecisionAgent(model="ornith-1.5")

    # ``_complete`` is a @staticmethod; patching it with a plain function makes
    # Python bind the instance as the first argument, so accept *args.
    def fake_complete(*_args):
        return complete_output

    with patch.object(OrnithDecisionAgent, "_complete", fake_complete):
        yield agent


def test_choice_happy_path():
    complete_output = json.dumps({"choice": "filter", "probabilities": {"filter": 0.7, "join": 0.3}})

    with _mocked_ornith(complete_output) as agent:
        questions = {
            "action": {
                "type": "choice",
                "instructions": "primary operation?",
                "criteria": {"filter": "restrict", "join": "combine"},
            }
        }

        result = agent.predict("find students", questions)

    # predict() nests every answer under ``answers[<question_name>]``.
    answer = result["answers"]["action"]
    assert answer["type"] == "choice"
    assert answer["choice"] == "filter"
    assert answer["probabilities"] == {"filter": 0.7, "join": 0.3}
    assert answer["answer_confidence"] == pytest.approx(0.7)
    assert answer["raw"] == complete_output


def test_choice_fallback_when_model_garbles_output():
    with _mocked_ornith("i think filter") as agent:
        questions = {
            "action": {
                "type": "choice",
                "instructions": "primary operation?",
                "criteria": {"filter": "restrict", "join": "combine"},
            }
        }

        result = agent.predict("find students", questions)

    answer = result["answers"]["action"]
    # _parse_json returns {} -> choice not in options -> deterministic fallback.
    assert answer["choice"] == "filter"
    assert answer["probabilities"] == {"filter": 0.5, "join": 0.5}
    assert answer["answer_confidence"] == pytest.approx(0.5)


def test_noul_lowercases_and_uses_probability():
    with _mocked_ornith('{"answer":"YES","probabilities":{"yes":0.2,"no":0.8}}') as agent:
        questions = {
            "confirmed": {
                "type": "noul",
                "instructions": "is it yes or no?",
            }
        }

        result = agent.predict("state", questions)

    # Input {yes:0.2, no:0.8}: "YES" lowercases to the chosen option "yes",
    # so confidence is the probability assigned to that choice (0.2).
    answer = result["answers"]["confirmed"]
    assert answer["type"] == "noul"
    assert answer["choice"] == "yes"
    assert answer["answer_confidence"] == pytest.approx(0.2)


def test_score_clamps_to_range():
    rating_questions = {
        "rating": {
            "type": "score",
            "instructions": "rate 0..2",
        }
    }

    with _mocked_ornith('{"score": 5}') as agent:
        result = agent.predict("state", rating_questions)
        assert result["answers"]["rating"]["score"] == pytest.approx(2.0)

    with _mocked_ornith('{"score": -3}') as agent:
        result = agent.predict("state", rating_questions)
        assert result["answers"]["rating"]["score"] == pytest.approx(0.0)

    with _mocked_ornith("no score here") as agent:
        result = agent.predict("state", rating_questions)
        assert result["answers"]["rating"]["score"] == 0.0
