"""The Modular Research Evaluator — a decision-support layer over the loop.

Evaluates each research iteration and answers: did it produce valid progress, how
strong is the evidence, what changed in the knowledge state, and what should the
loop do next? Built as a modular engine (deterministic rules + pluggable
evaluators + an optional LLM judge), never one giant prompt.

    model.py        canonical ResearchEvaluation + sub-records + constants
    text.py         tokenisation / overlap / similarity helpers
    base.py         EvaluationInput, DimensionEvaluator, DIMENSION_REGISTRY
    evidence.py     evidence taxonomy + strength model + source quality
    dimensions.py   the 14 scored dimensions
    passes.py       contradiction + redundancy detection
    recommend.py    pluggable RecommendationEngine (default: signal-driven)
    llm.py          optional, clamped LLM-assisted judgment
    pipeline.py     ResearchEvaluator — runs the passes, aggregates, persists

The loop calls `ResearchEvaluator.evaluate(input)` at its EVALUATING_PROGRESS
stage; the returned evaluation is persisted and its recommendation feeds the
NextActionSelector.
"""

from . import model as EM
from .base import DIMENSION_REGISTRY, DimensionEvaluator, EvaluationInput
from .pipeline import DEFAULT_EVALUATOR, EVALUATOR_REGISTRY, ResearchEvaluator
from .recommend import RECOMMENDATION_REGISTRY, RecommendationEngine

__all__ = [
    "DEFAULT_EVALUATOR",
    "DIMENSION_REGISTRY",
    "EM",
    "EVALUATOR_REGISTRY",
    "RECOMMENDATION_REGISTRY",
    "DimensionEvaluator",
    "EvaluationInput",
    "RecommendationEngine",
    "ResearchEvaluator",
]
