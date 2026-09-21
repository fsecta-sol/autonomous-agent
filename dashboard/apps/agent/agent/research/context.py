"""The context a pipeline module sees, and the ContextLoader that builds it.

Modules never reach back into the run or the store directly for shared inputs —
they receive a `ResearchContext` assembled once per iteration (plus the live
`Deps` bundle of collaborators). This keeps each module's contract explicit:
"given this context and these collaborators, produce this output."

The Context Manager concern (spec §2) lives here: what enters the model's context
is decided by the loader, not by a module deep in the pipeline.
"""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any

from . import models as M

log = logging.getLogger("agent.research.context")


@dataclass
class ResearchContext:
    """Everything a module needs to reason about the current iteration.

    `knowledge` is the rendered, provenance-carrying block from the Knowledge
    Manager's `get_relevant`; `relevant` is its structured form. Gaps are the
    detector's output for this iteration.
    """

    run_id: str
    objective: M.Objective
    iteration: int
    domain: str = ""
    relevant: list[dict] = field(default_factory=list)
    knowledge_text: str = ""
    gaps: list[dict] = field(default_factory=list)
    open_unknowns: list[dict] = field(default_factory=list)
    conflicts: list[dict] = field(default_factory=list)
    recent_attempts: list[dict] = field(default_factory=list)
    recent_iterations: list[dict] = field(default_factory=list)
    branch: str = "main"
    debug: bool = False
    extra: dict[str, Any] = field(default_factory=dict)

    def brief(self) -> dict:
        """A compact, JSON-safe summary for events/observability."""
        return {
            "runId": self.run_id,
            "iteration": self.iteration,
            "branch": self.branch,
            "relevantCount": len(self.relevant),
            "gapCount": len(self.gaps),
            "unknownCount": len(self.open_unknowns),
            "conflictCount": len(self.conflicts),
            "recentAttempts": len(self.recent_attempts),
        }


class ContextLoader(ABC):
    """Assembles the per-iteration context. Replaceable (spec §3)."""

    @abstractmethod
    async def load(self, run: M.ResearchRun, *, iteration: int, branch: str = "main") -> ResearchContext:
        ...


class DefaultContextLoader(ContextLoader):
    """Pulls the objective-relevant knowledge from the Knowledge Manager, records
    the recall prompt it used, and folds in the run's recent attempts so later
    stages can avoid repeating them."""

    def __init__(self, deps: Deps, *, recall_limit: int = 6):
        self.deps = deps
        self.recall_limit = recall_limit

    async def load(self, run: M.ResearchRun, *, iteration: int, branch: str = "main") -> ResearchContext:
        km = self.deps.km
        # The recall query is the objective plus any in-flight branch focus.
        query = run.objective.statement
        if run.objective.success_criteria:
            query += " " + " ".join(run.objective.success_criteria)
        if branch and branch != "main":
            query += f" {branch}"

        relevant: list[dict] = []
        knowledge_text = ""
        try:
            res = km.get_relevant(query, {"limit": self.recall_limit})
            relevant = res.get("nodes", []) or []
            knowledge_text = res.get("rendered", "") or ""
        except Exception:
            log.exception("knowledge recall failed for run %s", run.id)

        unknowns: list[dict] = []
        conflicts: list[dict] = []
        try:
            unknowns = km.find_unknowns("")
        except Exception:
            log.exception("find_unknowns failed")

        attempts = await self.deps.store.all_attempts(run.id)
        recent = await self.deps.store.list_iterations(run.id, limit=5)

        return ResearchContext(
            run_id=run.id,
            objective=run.objective,
            iteration=iteration,
            domain=run.objective.domain,
            relevant=relevant,
            knowledge_text=knowledge_text,
            open_unknowns=unknowns,
            conflicts=conflicts,
            recent_attempts=attempts,
            recent_iterations=[it.to_dict() for it in recent],
            branch=branch,
            debug=bool(self.deps.config.debug),
        )


# `Deps` is defined in loop.py (the loop owns the collaborators); this import is
# deferred only for typing. A runtime import would be circular, so we annotate
# loosely and let callers pass the real bundle.
if False:  # pragma: no cover
    from .loop import Deps
