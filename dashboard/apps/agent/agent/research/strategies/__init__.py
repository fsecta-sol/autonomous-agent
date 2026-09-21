"""The built-in research strategies and their registry.

Each strategy is small: it declares which gaps it handles, produces a plan shaped
for that kind of investigation, and executes via the executor. None of them touch
the loop; adding another is a new file + one `register` call.
"""

from __future__ import annotations

from .base import ResearchStrategy
from .documentation import DocumentationStrategy
from .experiment import ExperimentStrategy
from .registry import DEFAULT_STRATEGY, STRATEGY_REGISTRY
from .source_comparison import SourceComparisonStrategy
from .web import WebResearchStrategy

__all__ = [
    "DEFAULT_STRATEGY",
    "STRATEGY_REGISTRY",
    "DocumentationStrategy",
    "ExperimentStrategy",
    "ResearchStrategy",
    "SourceComparisonStrategy",
    "WebResearchStrategy",
]
