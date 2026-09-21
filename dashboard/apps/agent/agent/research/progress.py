"""ProgressEvaluator — folds an iteration's evaluation into cumulative progress
(spec §16).

Progress is measured in *information gained*, never in tasks completed: new
knowledge nodes, new relationships, newly surfaced conflicts. An iteration that
adds none of those (however much it re-interprets or re-verifies, or how many
open questions it spawns) increments a `low_value_streak` that the
diminishing-returns stop condition reads — so a plateau eventually ends the run.
"""

from __future__ import annotations

from . import models as M


class ProgressEvaluator:
    def __init__(self, *, min_useful_info_gain: float = 0.15):
        self.floor = min_useful_info_gain

    def apply(
        self,
        progress: M.Progress,
        evaluation: M.Evaluation,
        updates: list[dict],
    ) -> M.Progress:
        """Return the updated Progress (mutates and returns for convenience)."""
        progress.iterations += 1
        progress.info_gain = round(progress.info_gain + evaluation.info_gain, 4)

        created = sum(1 for u in updates if u.get("op") in ("create", "new"))
        enriched = sum(1 for u in updates if u.get("op") in ("update", "interpretation"))
        verified = sum(1 for u in updates if u.get("op") == "verified")
        unknowns = sum(1 for u in updates if u.get("op") == "unknown")
        relations = sum(1 for u in updates if u.get("op") == "relation")

        progress.knowledge_created += created
        progress.knowledge_updated += enriched
        progress.unknowns_created += unknowns
        progress.relationships_added += relations
        progress.evidence_items += 1 if evaluation.new_evidence else 0
        if evaluation.contradiction_created:
            progress.conflicts_found += 1
        if evaluation.hypothesis_survived is False:
            progress.hypotheses_rejected += 1
        # verified nodes count as resolved uncertainties
        progress.unknowns_resolved += verified

        # diminishing returns: only *durable* graph growth resets the streak —
        # a new node or a new edge. Deliberately excluded: `unknowns` (creating
        # an open question is the opposite of gaining information, and a
        # sub-agent that always returns uncertainties would otherwise reset the
        # streak every iteration, so the run could never stop), `enriched`
        # (re-interpreting existing text), `verified` (a confidence signal
        # already implied by info_gain), and — newly — `contradiction_created`:
        # surfacing a conflict is not new knowledge, and counting it as durable
        # let a run that only ever found conflicts reset the streak forever and
        # never plateau (a 27h run reached a 0-node, 89-conflict steady state it
        # could not stop out of). Conflicts still increment `conflicts_found`.
        durable = created or relations
        useful = evaluation.info_gain >= self.floor and durable
        if useful:
            progress.low_value_streak = 0
        else:
            progress.low_value_streak += 1
        return progress

    def objective_satisfied(self, progress: M.Progress, criteria: list[str], *, coverage: float, threshold: float = 0.8) -> bool:
        """A coarse objective check: enough created/verified knowledge AND the
        graph covers the objective (coverage computed by the loop from gaps)."""
        if not criteria:
            return coverage >= threshold and progress.knowledge_created + progress.unknowns_resolved > 0
        knowledge_signal = (progress.knowledge_created + progress.unknowns_resolved) >= len(criteria)
        return coverage >= threshold and knowledge_signal
