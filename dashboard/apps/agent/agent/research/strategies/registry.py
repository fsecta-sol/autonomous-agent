"""The strategy registry. Strategies are cheap factories over an executor, so the
registry stores `name -> factory(executor) -> ResearchStrategy` and the loop
builds the concrete set (filtered by the run's allow-list) at drive time."""

from __future__ import annotations

from collections.abc import Callable

from ..executor import ResearchExecutor
from ..registry import Registry
from .base import ResearchStrategy
from .documentation import DocumentationStrategy
from .experiment import ExperimentStrategy
from .source_comparison import SourceComparisonStrategy
from .web import WebResearchStrategy

StrategyFactory = Callable[[ResearchExecutor], ResearchStrategy]

STRATEGY_REGISTRY: Registry[StrategyFactory] = Registry("strategy")

# Name shown when a candidate matches no specialised strategy.
DEFAULT_STRATEGY = "web"


def _register_builtins() -> None:
    STRATEGY_REGISTRY.register("documentation", lambda ex: DocumentationStrategy(ex))
    STRATEGY_REGISTRY.register("web", lambda ex: WebResearchStrategy(ex))
    STRATEGY_REGISTRY.register("source-comparison", lambda ex: SourceComparisonStrategy(ex))
    STRATEGY_REGISTRY.register("experiment", lambda ex: ExperimentStrategy(ex))


_register_builtins()


def build_strategies(executor: ResearchExecutor, names: list[str] | None = None) -> list[ResearchStrategy]:
    """Instantiate the strategies for a run. `names` empty/None = all registered,
    else only the named ones that exist (unknown names are skipped, not fatal)."""
    chosen = names or STRATEGY_REGISTRY.names()
    out: list[ResearchStrategy] = []
    for n in chosen:
        if not STRATEGY_REGISTRY.has(n):
            continue
        factory = STRATEGY_REGISTRY.get(n)
        out.append(factory(executor))
    return out
