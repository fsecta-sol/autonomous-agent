"""ResearchExecutor — the boundary between research planning and execution (§13).

The loop and its strategies never call a tool directly. A strategy hands its plan
to an executor, which is responsible for *running* it and returning a
`ResearchResult`. In production that executor delegates to the existing agent
runtime (`run_subagent`, the same headless LangGraph agent the orchestrator
already spawns), so research reuses the real tool/orchestration stack.

Two implementations:

  * `SubagentExecutor`  — production: runs a sub-agent seeded with the plan and
                          parses its evidence-first JSON reply.
  * `ScriptedExecutor`  — tests/debug: returns a canned result per question, so
                          the loop is exercised deterministically with no model.
"""

from __future__ import annotations

import json
import logging
import re
import time
from abc import ABC, abstractmethod

from langchain_core.tools import BaseTool

from ..models import RunRequest
from ..subagent import run_subagent_messages, trace_from_messages
from . import models as M

log = logging.getLogger("agent.research.executor")

_JSON_OBJ_RE = re.compile(r"\{[\s\S]*\}")

# The contract we ask a sub-agent to satisfy. Kept explicit and evidence-first so
# observations stay separable from conclusions.
_EVIDENCE_CONTRACT = """\
Return a single JSON object and nothing else:
{
  "observations": [{"statement": "a raw, low-inference fact you directly saw", "source": "url / command / file"}],
  "evidence": [{"kind": "observation|source|experiment|artifact|measurement", "statement": "...", "source": "..."}],
  "sources": ["url", ...],
  "conclusions": ["your interpretation — explicitly your reading, not a fact"],
  "uncertainties": ["what you could not determine"],
  "hypothesis_survived": true | false | null
}
Do not put interpretation in observations. If you found nothing, return empty arrays and say why in uncertainties.
"""


class ResearchExecutor(ABC):
    @abstractmethod
    async def execute(self, plan: M.ResearchPlan, ctx: ResearchContext, run: M.ResearchRun) -> M.ResearchResult:
        ...

    def seed_config(self) -> dict | None:
        """The `RunRequest`-shaped config this executor was built from, or None.

        The loop persists this on the run so a *fresh process* can rebuild the
        same executor when it resumes the run (see `ResearchLoop.start`). Without
        it, a restarted process rebuilt the loop with no credentials and silently
        fell back to the scripted no-op. `None` when there is nothing to seed
        (e.g. the scripted test executor)."""
        return None


def _result_from_subagent_text(plan: M.ResearchPlan, text: str, *, tool_calls: int, seconds: float, failure_kind: str = M.FAIL_NONE) -> M.ResearchResult:
    """Parse a sub-agent's reply into a ResearchResult, tolerating prose/fences.

    A parse failure does not discard the work: the whole text becomes one
    observation and one uncertainty, never a fabricated conclusion.
    """
    payload: dict = {}
    m = _JSON_OBJ_RE.search(text or "")
    if m:
        try:
            payload = json.loads(m.group(0))
        except json.JSONDecodeError:
            payload = {}

    if not isinstance(payload, dict) or not payload:
        obs = [{"statement": (text or "").strip()[:2000], "source": "sub-agent"}] if (text or "").strip() else []
        return M.ResearchResult(
            id=M.new_id("res_"),
            candidate_id=plan.candidate_id,
            iteration_id="",
            strategy=plan.strategy,
            question=plan.question,
            observations=obs,
            uncertainties=["The sub-agent's reply could not be parsed as structured evidence."],
            failure_kind=failure_kind or (M.FAIL_INSUFFICIENT_EVIDENCE if not obs else M.FAIL_NONE),
            cost={"tool_calls": tool_calls, "seconds": round(seconds, 2)},
        )

    def _as_list(key: str) -> list:
        v = payload.get(key)
        return v if isinstance(v, list) else []

    obs = [o for o in _as_list("observations") if isinstance(o, (dict, str))]
    obs_norm = [
        o if isinstance(o, dict) else {"statement": str(o), "source": ""} for o in obs
    ]
    ev = [e for e in _as_list("evidence") if isinstance(e, dict)]
    survived = payload.get("hypothesis_survived")
    if survived not in (True, False, None):
        survived = None
    result = M.ResearchResult(
        id=M.new_id("res_"),
        candidate_id=plan.candidate_id,
        iteration_id="",
        strategy=plan.strategy,
        question=plan.question,
        observations=obs_norm,
        evidence=ev,
        sources=[str(s) for s in _as_list("sources")],
        conclusions=[str(c) for c in _as_list("conclusions")],
        uncertainties=[str(u) for u in _as_list("uncertainties")],
        hypothesis_survived=survived,
        failure_kind=failure_kind,
        cost={"tool_calls": tool_calls, "seconds": round(seconds, 2)},
    )
    if not obs_norm and not ev and failure_kind == M.FAIL_NONE:
        result.failure_kind = M.FAIL_INSUFFICIENT_EVIDENCE
        result.failure_reason = "the sub-agent returned no observations or evidence"
    return result


class SubagentExecutor(ResearchExecutor):
    """Runs each plan as a headless sub-agent using the run's LLM + tools.

    `req` is the RunRequest the research run executes under (LLM creds resolved by
    the backend); `tools` are the sub-agent's tools. Neither is persisted — a
    resumed drive re-supplies them, keeping the agent stateless.
    """

    def __init__(self, req: RunRequest, tools: list[BaseTool], *, timeout_s: float = 300.0):
        self.req = req
        self.tools = tools
        self.timeout_s = timeout_s

    def seed_config(self) -> dict | None:
        # `exclude_none=False` so the round-trip through `RunRequest.model_validate`
        # keeps every field the run was created with (tools, terminal mode, etc.).
        return self.req.model_dump()

    async def execute(self, plan: M.ResearchPlan, ctx: ResearchContext, run: M.ResearchRun) -> M.ResearchResult:
        goal = _goalfrom(plan, ctx)
        started = time.time()
        text, timed_out, messages = await run_subagent_messages(self.req, "researcher", goal, self.tools, self.timeout_s)
        seconds = time.time() - started
        failure = M.FAIL_TIMEOUT if timed_out else M.FAIL_NONE
        result = _result_from_subagent_text(plan, text, tool_calls=0, seconds=seconds, failure_kind=failure)
        # The sub-agent's observable activity trail — what it did and what came
        # back — persisted alongside the result so the UI can show the work, not
        # just its conclusion.
        result.trace = trace_from_messages(messages)
        if timed_out:
            result.failure_reason = (
                f"the research sub-agent stalled (no progress for {self.timeout_s:.0f}s)"
                + (f"; harvested {len(messages)} partial message(s)" if messages else "")
            )
        return result


def _goalfrom(plan: M.ResearchPlan, ctx: ResearchContext) -> str:
    steps = "\n".join(f"{i + 1}. {s}" for i, s in enumerate(plan.steps)) or "1. Investigate the question."
    focus = f"\nObjective: {ctx.objective.statement}" if ctx.objective.statement else ""
    knowledge = f"\n\nWhat the graph already knows:\n{ctx.knowledge_text}" if ctx.knowledge_text else ""
    return (
        f"Research this question using your tools: {plan.question}{focus}\n\n"
        f"Plan:\n{steps}\n\n"
        f"Expected evidence: {', '.join(plan.expected_evidence) or 'any direct evidence'}.{knowledge}\n\n"
        f"{_EVIDENCE_CONTRACT}"
    )


class ScriptedExecutor(ResearchExecutor):
    """Deterministic executor for tests/debug. Maps a plan (by strategy or by a
    predicate on the question) to a canned ResearchResult.

    Build with a list of `(predicate, result_factory)` rules; the first matching
    predicate wins. A default rule produces a minimal "nothing found" result so
    unmatched plans still exercise the failure path.
    """

    def __init__(self, rules: list[tuple] | None = None, *, default: M.ResearchResult | None = None):
        self.rules = rules or []
        self.default = default
        self.calls: list[M.ResearchPlan] = []

    async def execute(self, plan: M.ResearchPlan, ctx: ResearchContext, run: M.ResearchRun) -> M.ResearchResult:
        self.calls.append(plan)
        for predicate, factory in self.rules:
            if callable(predicate):
                try:
                    matched = predicate(plan, ctx)
                except Exception:  # noqa: BLE001
                    matched = False
            else:
                # a string predicate matches a strategy name; "any"/"*" is a
                # wildcard so a catch-all rule can be expressed as data.
                matched = predicate in ("any", "*") or predicate == plan.strategy
            if matched:
                result = factory(plan, ctx) if callable(factory) else factory
                result.candidate_id = plan.candidate_id or result.candidate_id
                result.strategy = plan.strategy
                result.question = result.question or plan.question
                return result
        if self.default is not None:
            d = self.default
            d.candidate_id = plan.candidate_id or d.candidate_id
            d.strategy = plan.strategy
            d.question = d.question or plan.question
            return d
        return M.ResearchResult(
            id=M.new_id("res_"),
            candidate_id=plan.candidate_id,
            iteration_id="",
            strategy=plan.strategy,
            question=plan.question,
            failure_kind=M.FAIL_INSUFFICIENT_EVIDENCE,
            failure_reason="scripted executor had no matching rule",
        )


if False:  # pragma: no cover
    from .context import ResearchContext
