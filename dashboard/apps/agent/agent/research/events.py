"""Event bus for the Research Loop.

Two consumers, one emit:

  * the durable log  — the store writes every event to SQLite (queryable) and a
                       JSONL mirror (tailable). See `store.record_event`.
  * live subscribers — an SSE stream attaches an `asyncio.Queue` and is pushed
                       each event the moment it happens.

The bus is process-local (matching the single-process agent service), so a
subscriber in another process reads the durable log instead. Emitting never
raises: a run must not fail because a subscriber went away.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import asdict, dataclass, field
from typing import Any

from .models import new_id, now_ms

log = logging.getLogger("agent.research.events")

# The event vocabulary (spec §27). Kept as constants so emitters and subscribers
# agree on the wire names.
RESEARCH_STARTED = "RESEARCH_STARTED"
RESEARCH_PAUSED = "RESEARCH_PAUSED"
RESEARCH_RESUMED = "RESEARCH_RESUMED"
RESEARCH_COMPLETED = "RESEARCH_COMPLETED"
RESEARCH_FAILED = "RESEARCH_FAILED"
RESEARCH_CANCELLED = "RESEARCH_CANCELLED"
ITERATION_STARTED = "ITERATION_STARTED"
ITERATION_FINISHED = "ITERATION_FINISHED"
CONTEXT_LOADED = "CONTEXT_LOADED"
KNOWLEDGE_ANALYZED = "KNOWLEDGE_ANALYZED"
CANDIDATES_GENERATED = "CANDIDATES_GENERATED"
CANDIDATE_SELECTED = "CANDIDATE_SELECTED"
PLAN_CREATED = "PLAN_CREATED"
EXECUTION_STARTED = "RESEARCH_EXECUTION_STARTED"
EVIDENCE_COLLECTED = "EVIDENCE_COLLECTED"
RESULT_CREATED = "RESEARCH_RESULT_CREATED"
KNOWLEDGE_UPDATED = "KNOWLEDGE_UPDATED"
PROGRESS_EVALUATED = "PROGRESS_EVALUATED"
RESEARCH_EVALUATED = "RESEARCH_EVALUATED"
NEXT_ACTION_SELECTED = "NEXT_ACTION_SELECTED"
BRANCH_CREATED = "BRANCH_CREATED"
STAGE_CHANGED = "STAGE_CHANGED"


@dataclass
class ResearchEvent:
    id: str
    run_id: str
    type: str
    iteration_index: int | None = None
    data: dict[str, Any] = field(default_factory=dict)
    ts: int = field(default_factory=now_ms)

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_row(cls, row: dict) -> ResearchEvent:
        return cls(
            id=row["id"],
            run_id=row["run_id"],
            type=row["type"],
            iteration_index=row.get("iteration_index"),
            data=row.get("data") or {},
            ts=row["ts"],
        )


class EventBus:
    """Per-run live fan-out. Subscribers get an asyncio.Queue; `publish` is
    non-blocking (a full queue is dropped, never awaited)."""

    def __init__(self) -> None:
        self._subs: dict[str, list[asyncio.Queue]] = {}

    def subscribe(self, run_id: str, maxsize: int = 256) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=maxsize)
        self._subs.setdefault(run_id, []).append(q)
        return q

    def unsubscribe(self, run_id: str, q: asyncio.Queue) -> None:
        subs = self._subs.get(run_id)
        if not subs:
            return
        try:
            subs.remove(q)
        except ValueError:
            pass
        if not subs:
            self._subs.pop(run_id, None)

    def publish(self, event: ResearchEvent) -> None:
        for q in list(self._subs.get(event.run_id, [])):
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                # A slow subscriber must never back-pressure the loop.
                log.debug("research subscriber queue full for run %s", event.run_id)

    def subscriber_count(self, run_id: str) -> int:
        return len(self._subs.get(run_id, []))


def make_event(run_id: str, type_: str, *, iteration_index: int | None = None, **data: Any) -> ResearchEvent:
    return ResearchEvent(id=new_id("ev_"), run_id=run_id, type=type_, iteration_index=iteration_index, data=data)
