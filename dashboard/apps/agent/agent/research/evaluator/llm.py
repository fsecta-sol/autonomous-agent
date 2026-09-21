"""Optional LLM-assisted judgment (spec: "optional LLM-assisted judgment").

The evaluator is deterministic by default. When enabled, an `LlmJudge` may add
qualitative notes and *bounded* adjustments to the deterministic scores — it can
never make a conclusion outrank its evidence, and its adjustments are clamped so
a model cannot override the rule-based grading wholesale. The judge is optional
and never required for the loop to run.

Two implementations:
  * `NoopJudge`   — the default: returns no adjustments.
  * `CallableJudge` — wraps any async `fn(system, user) -> str`, so a deployment
                      can plug the run's model without this module importing it.
"""

from __future__ import annotations

import json
import logging
import re
from abc import ABC, abstractmethod
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

from . import model as EM
from .base import EvaluationInput

log = logging.getLogger("agent.research.evaluator.llm")

_JSON_RE = re.compile(r"\{[\s\S]*\}")

# How far a judge may move a deterministic score (absolute), so the model nudges
# rather than overrides.
MAX_ADJUSTMENT = 0.2

_JUDGE_SYSTEM = (
    "You are a strict research evaluator. Judge only from the evidence shown; never "
    "treat a conclusion as stronger than its evidence. Reply with a single JSON "
    'object: {"adjustments": {"<dimension>": <delta -0.2..0.2>}, "notes": [string]}. '
    "Omit a dimension to leave it unchanged. No other text."
)


@dataclass
class JudgeResult:
    adjustments: dict[str, float] = field(default_factory=dict)
    notes: list[str] = field(default_factory=list)
    used: bool = False


class LlmJudge(ABC):
    @abstractmethod
    async def judge(self, inp: EvaluationInput, dimensions: dict[str, float]) -> JudgeResult:
        ...


class NoopJudge(LlmJudge):
    async def judge(self, inp: EvaluationInput, dimensions: dict[str, float]) -> JudgeResult:
        return JudgeResult()


class CallableJudge(LlmJudge):
    """Adapts an async `fn(system, user) -> str` (the run's model) into a judge.

    Adjustments are clamped to ±MAX_ADJUSTMENT per dimension, so the deterministic
    grade survives.
    """

    def __init__(self, fn: Callable[[str, str], Awaitable[str]]):
        self.fn = fn

    async def judge(self, inp: EvaluationInput, dimensions: dict[str, float]) -> JudgeResult:
        user = json.dumps(
            {
                "question": inp.question,
                "objective": inp.objective.statement,
                "result": inp.result.to_dict() if inp.result else None,
                "dimensions": dimensions,
            },
            ensure_ascii=False,
        )
        try:
            raw = await self.fn(_JUDGE_SYSTEM, user)
        except Exception:
            log.exception("llm judge failed")
            return JudgeResult(used=False)
        out = JudgeResult(used=True)
        m = _JSON_RE.search(raw or "")
        if not m:
            return out
        try:
            payload = json.loads(m.group(0))
        except json.JSONDecodeError:
            return out
        adj = payload.get("adjustments")
        if isinstance(adj, dict):
            for k, v in adj.items():
                if isinstance(v, (int, float)) and k in dimensions:
                    out.adjustments[k] = max(-MAX_ADJUSTMENT, min(MAX_ADJUSTMENT, float(v)))
        notes = payload.get("notes")
        if isinstance(notes, list):
            out.notes = [str(n) for n in notes][:8]
        return out


def apply_adjustments(dimensions: dict[str, float], judge: JudgeResult) -> dict[str, float]:
    """Apply a judge's clamped deltas to the dimension scores."""
    if not judge.used or not judge.adjustments:
        return dimensions
    out = dict(dimensions)
    for k, delta in judge.adjustments.items():
        if k in out:
            out[k] = round(max(0.0, min(1.0, out[k] + delta)), 4)
    return out


# Re-export the level constant so a caller building a judge prompt has the taxonomy.
OBSERVATION_LEVEL = EM.LEVEL_OBSERVATION
