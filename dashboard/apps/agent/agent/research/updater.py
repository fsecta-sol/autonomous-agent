"""KnowledgeUpdater — integrates a research result into the Knowledge Manager
(spec §25).

The rule that keeps the graph honest (spec §14): **observations and evidence are
the durable knowledge; conclusions are interpretation and are never promoted to
fact.** So the updater:

  * builds the knowledge text from observations + evidence (never from bare
    conclusions),
  * files it through `KnowledgeManager.create_knowledge`, which owns dedup,
    conflict detection, and the create-vs-enrich decision,
  * attaches the evidence trail, and
  * sets a confidence bounded by evidence strength — a verified_at is only set
    when the evidence is strong and the hypothesis survived. Conclusions are
    recorded in the note's Notes, clearly labelled, at reduced confidence.

It returns an audit list of what it did, which the iteration persists.
"""

from __future__ import annotations

import logging
import re
from abc import ABC, abstractmethod

from . import models as M

log = logging.getLogger("agent.research.updater")

# The gap detector asks questions in a handful of fixed shapes; each names its
# subject as the tail. Mapping them back to that subject is what lets the manager
# match the EXISTING node and enrich it, instead of forking a node titled after
# the whole question. Order matters — most specific first.
_SUBJECT_PATTERNS = [
    re.compile(r"verify the claims in (.+)$", re.IGNORECASE),
    re.compile(r"substantiate the claims in (.+)$", re.IGNORECASE),
    re.compile(r"what is (.+?) and how does it work", re.IGNORECASE),
    re.compile(r"which claim is correct about (.+?)(?:,|$)", re.IGNORECASE),
    re.compile(r"anything about (.+?) changed", re.IGNORECASE),
    re.compile(r"relate to (.+)$", re.IGNORECASE),
]


class KnowledgeUpdater(ABC):
    @abstractmethod
    async def update(self, result: M.ResearchResult, evaluation: M.Evaluation, run: M.ResearchRun,
                     *, conflict_targets: list[str] | None = None) -> list[dict]:
        """Integrate the result. Returns the list of knowledge updates applied."""
        ...


class KnowledgeManagerUpdater(KnowledgeUpdater):
    """Writes into the Markdown graph via the KnowledgeManager. Every write goes
    through the manager, so the graph's dedup/conflict rules always apply."""

    def __init__(self, km, *, verify_floor: float = 0.7):
        self.km = km
        self.verify_floor = verify_floor  # evidence strength to mark verified

    def _title(self, result: M.ResearchResult) -> str:
        """A stable node title for the finding — the question's *subject*, so the
        manager's dedup can match an existing node rather than fork a new one."""
        raw = (result.question or "").strip()
        # first, if the question is one of the gap detector's fixed shapes, pull the
        # subject it names — this is what routes "verify the claims in mempool" to
        # the existing [[mempool]] node.
        for pat in _SUBJECT_PATTERNS:
            m = pat.search(raw)
            if m:
                subject = m.group(1).strip().strip("?.,;:").strip()
                if subject and len(subject.split()) <= 4:
                    return subject[:60]
        q = raw.rstrip("?.").strip()
        # strip a leading interrogative so "what is X" -> "X"
        for lead in ("what is ", "what are ", "how does ", "how do ", "does ", "why does ", "why do ",
                     "how is ", "what do ", "which ", "who is "):
            if q.lower().startswith(lead):
                q = q[len(lead):].strip()
                break
        # drop a trailing clause ("X, and how does it relate to Y" -> "X")
        for cut in (",", " and how ", " and why ", " and what ", " and which ", " relate to ", " relate "):
            i = q.lower().find(cut)
            if i > 0:
                q = q[:i].strip()
        q = q.strip().strip(",;:").strip()
        return (q[:60] or raw[:60] or "research-finding").strip()

    def _knowledge_text(self, result: M.ResearchResult) -> str:
        """Observations + evidence only — the durable, low-inference core."""
        parts: list[str] = []
        for o in result.observations[:6]:
            st = o.get("statement", "") if isinstance(o, dict) else str(o)
            src = o.get("source", "") if isinstance(o, dict) else ""
            if st:
                parts.append(f"- {st}" + (f" (source: {src})" if src else ""))
        for e in result.evidence[:6]:
            if isinstance(e, dict) and e.get("statement"):
                parts.append(f"- {e['statement']}" + (f" (source: {e.get('source')})" if e.get("source") else ""))
        return "\n".join(parts) if parts else (result.question or "research finding")

    async def update(self, result: M.ResearchResult, evaluation: M.Evaluation, run: M.ResearchRun,
                     *, conflict_targets: list[str] | None = None) -> list[dict]:
        updates: list[dict] = []
        # A failed/empty result changes no knowledge — but a rejected hypothesis is
        # recorded as evidence on the target node (it is information).
        if evaluation.failed and not result.observations and not result.evidence:
            return updates

        title = self._title(result)
        text = self._knowledge_text(result)
        sources = list(result.sources or [])
        evidence_lines = [f"{e.get('kind', 'evidence')}: {e.get('statement', '')} — {e.get('source', '')}".strip()
                          for e in result.evidence if isinstance(e, dict) and e.get("statement")]
        evidence_lines += [f"research:{run.id}/{result.strategy}"] if not evidence_lines else []

        # integrate (create / enrich / conflict resolved by the manager)
        try:
            out = self.km.create_knowledge(
                title=title,
                text=text,
                sources=sources,
                evidence=evidence_lines,
                contradicts=(conflict_targets or None),  # candidates that target a known conflict
                task_id=run.id,
                research_id=result.strategy,
                source="research-loop",
            )
        except Exception:
            log.exception("knowledge update failed for run %s", run.id)
            return [{"op": "error", "question": result.question}]

        action = out.get("action", "?")
        node_id = out.get("id", title)
        updates.append({"op": action.lower(), "id": node_id, "question": result.question})

        # evidence trail + confidence, on a node that now exists
        try:
            if evidence_lines:
                self.km.add_evidence(node_id, evidence_lines, task_id=run.id, source="research-loop")
            # confidence bounded by evidence strength; verified only at the floor
            strength = evaluation.info_gain
            if strength >= self.verify_floor and result.hypothesis_survived is not False:
                self.km.verify(node_id, evidence_lines[:1], confidence="high", task_id=run.id, source="research-loop")
                updates.append({"op": "verified", "id": node_id})
            # below the floor the node stays unverified — its evidence trail is
            # attached but no confidence is asserted (never over-claim).
        except Exception:
            log.exception("evidence/verify attach failed for %s", node_id)

        # conclusions are recorded in Notes, clearly labelled and not as facts
        if result.conclusions:
            try:
                note = "\n".join(f"- (interpretation) {c}" for c in result.conclusions[:4])
                self.km.update_knowledge(node_id, text=note, task_id=run.id, source="research-loop")
                updates.append({"op": "interpretation", "id": node_id})
            except Exception:
                log.exception("conclusion note failed for %s", node_id)

        # new unknowns from surfaced uncertainties
        for u in (result.uncertainties or [])[:3]:
            try:
                r = self.km.create_unknown(question=str(u), id="", investigations=[f"research:{run.id}"], task_id=run.id)
                updates.append({"op": "unknown", "id": r.get("id", "")})
            except Exception:
                log.exception("unknown create failed")

        return updates


if False:  # pragma: no cover
    from ..knowledge.manager import KnowledgeManager  # noqa: F401
