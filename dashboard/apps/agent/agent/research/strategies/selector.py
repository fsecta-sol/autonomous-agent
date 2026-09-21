"""StrategySelector — capability matching + selection (spec §11).

Given a candidate and the available strategies, pick the best one. The default
selector scores each capable strategy by a small, inspectable heuristic:

    score = reliability * gain_weight - cost * cost_weight - failure_penalty

where `failure_penalty` rises with how many times that strategy already failed on
this exact question (from the attempt ledger), so a repeatedly-failing approach
is abandoned in favour of another capable one. The selector is replaceable — the
loop asks it to select and trusts the result.

When no specialised strategy matches, the registry's default ("web") is used.
"""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod

from .. import models as M
from ..candidates import question_key
from .base import ResearchStrategy

log = logging.getLogger("agent.research.selector")

_GAIN_WEIGHT = {"high": 1.0, "medium": 0.7, "low": 0.4}


class StrategySelector(ABC):
    @abstractmethod
    async def select(self, candidate: M.ResearchCandidate, ctx: ResearchContext) -> ResearchStrategy:
        ...

    def candidates_for(self, candidate: M.ResearchCandidate, ctx: ResearchContext) -> list[ResearchStrategy]:
        return [s for s in self.strategies if s.can_handle(candidate, ctx)]


class WeightedStrategySelector(StrategySelector):
    def __init__(self, strategies: list[ResearchStrategy], *, default_name: str = "web"):
        self.strategies = strategies
        self.default_name = default_name

    async def select(self, candidate: M.ResearchCandidate, ctx: ResearchContext) -> ResearchStrategy:
        pool = self.candidates_for(candidate, ctx) or self.strategies
        if not pool:
            raise RuntimeError("no research strategies are registered")
        # priors: how many times each strategy already failed on this question
        q = question_key(candidate.question)
        fails: dict[str, int] = {}
        tried: set[str] = set()
        for a in ctx.recent_attempts:
            if a.get("question_norm") == q:
                tried.add(a.get("strategy", ""))
                if a.get("outcome") in ("failed", "error"):
                    fails[a.get("strategy", "")] = fails.get(a.get("strategy", ""), 0) + 1

        gain_w = _GAIN_WEIGHT.get(candidate.expected_information_gain, 0.7)
        best: ResearchStrategy | None = None
        best_score = float("-inf")
        for s in pool:
            score = s.reliability * gain_w - s.cost * 0.5 - fails.get(s.name, 0) * 0.6
            # a strategy never tried on this question gets a small novelty bump
            if s.name not in tried:
                score += 0.1
            if score > best_score:
                best, best_score = s, score
        assert best is not None
        return best


if False:  # pragma: no cover
    from ..context import ResearchContext
