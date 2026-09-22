"""ResearchLoop — the explicit, resumable state machine (spec §4, §26, §28, §34).

The loop owns no logic of its own; it sequences the modules. `step()` runs exactly
ONE stage transition and persists, so a run is interruptible after any stage and
resumable from disk. `advance()` steps until the run is terminal, paused, or
waiting. The stage set is the spec's state machine; the branch at
DECIDING_NEXT_ACTION is applied by `_decide`.

Concurrency (§34): an in-process `asyncio.Lock` per run serialises steps, and a
persisted lease (owner + expiry, in the run's metadata) guards against a second
process driving the same run.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Any

from . import events as E
from . import models as M
from .analyzer import ANALYZER_REGISTRY, DEFAULT_ANALYZER, ResultAnalyzer
from .candidates import CandidateEvaluator, CandidateGenerator, GapBasedCandidateGenerator, HeuristicCandidateEvaluator
from .config import ResearchConfig
from .context import ContextLoader, DefaultContextLoader, ResearchContext
from .evaluator import DEFAULT_EVALUATOR, EVALUATOR_REGISTRY, ResearchEvaluator
from .evaluator import model as EModel
from .evaluator.base import EvaluationInput
from .events import EventBus, make_event
from .executor import ResearchExecutor
from .gaps import DefaultGapDetector, KnowledgeGapDetector
from .nextaction import DefaultNextActionSelector, NextAction, NextActionSelector
from .planner import DefaultResearchPlanner, ResearchPlanner
from .prioritizer import DEFAULT_PRIORITIZER, PRIORITIZER_REGISTRY, ResearchPrioritizer
from .progress import ProgressEvaluator
from .stop import StopState, evaluate_stops
from .store import ResearchStore
from .strategies.registry import DEFAULT_STRATEGY, build_strategies
from .strategies.selector import WeightedStrategySelector
from .updater import KnowledgeManagerUpdater, KnowledgeUpdater


def _workspace_for(run_id: str):
    """The staging workspace a run writes its notes into until it finishes.

    Isolating a run's Markdown this way keeps an off-topic or exploratory run
    from dirtying the shared vault; a note is only promoted in once the run is
    terminal (see `_promote_workspace`)."""
    from ..config import agent_workspaces_root

    return agent_workspaces_root() / run_id


def _promote_workspace(run_id: str, log_) -> dict:
    """Copy a finished run's staged notes into the vault — only notes the vault
    does not already have. Never overwrites or deletes an existing vault note, so
    promotion is additive and safe to repeat. Returns a small summary."""
    from ..config import vault_root

    ws = _workspace_for(run_id)
    if not ws.is_dir():
        return {"promoted": 0, "skipped": 0, "workspace": str(ws)}
    vault = vault_root()
    # never promote into a workspace root that IS the vault write root (no-op)
    promoted = skipped = 0
    from ..knowledge import vault_store

    for folder in ("03-Areas/concepts", "02-Projects"):
        d = ws / folder
        if not d.is_dir():
            continue
        for src in sorted(d.glob("*.md")):
            rel = f"{folder}/{src.name}"
            try:
                dest = (vault / rel)
                if dest.exists():
                    skipped += 1
                    continue
                dest.parent.mkdir(parents=True, exist_ok=True)
                text = src.read_text(encoding="utf-8", errors="replace")
                vault_store.write(rel, text, backup=False)
                promoted += 1
            except Exception:
                log_.exception("promote failed for %s", rel)
                skipped += 1
    return {"promoted": promoted, "skipped": skipped, "workspace": str(ws)}

log = logging.getLogger("agent.research.loop")

LEASE_TTL_MS = 60_000

# One lock per run, shared by EVERY ResearchLoop instance in the process (the
# service builds a loop per run, and tests build several). A per-instance lock
# would not serialise two loops racing the same run; this does. It is a
# process-level guard — the persisted lease below is the cross-process one.
_RUN_LOCKS: dict[str, asyncio.Lock] = {}


def _lock_for(run_id: str) -> asyncio.Lock:
    lock = _RUN_LOCKS.get(run_id)
    if lock is None:
        lock = asyncio.Lock()
        _RUN_LOCKS[run_id] = lock
    return lock


@dataclass
class ResearchStepResult:
    run_id: str
    stage_before: str
    stage_after: str
    status: str
    iteration: int
    iteration_id: str | None = None
    done: bool = False
    output: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "runId": self.run_id,
            "stageBefore": self.stage_before,
            "stageAfter": self.stage_after,
            "status": self.status,
            "iteration": self.iteration,
            "iterationId": self.iteration_id,
            "done": self.done,
            "output": self.output,
        }


@dataclass
class Deps:
    """The collaborator bundle a loop drives. Every module interface is here, so
    a test or an alternate deployment swaps one without touching the loop.

    `context_loader` and `gap_detector` are deps-bound (they need the bundle
    themselves), so they are filled in by `build_default_deps` right after the
    bundle exists — hence the `None` defaults here.
    """

    store: ResearchStore
    km: Any
    config: ResearchConfig
    bus: EventBus
    executor: ResearchExecutor
    candidate_generator: CandidateGenerator
    candidate_evaluator: CandidateEvaluator
    prioritizer: ResearchPrioritizer
    planner: ResearchPlanner
    analyzer: ResultAnalyzer
    updater: KnowledgeUpdater
    progress_evaluator: ProgressEvaluator
    next_action: NextActionSelector
    evaluator: ResearchEvaluator
    context_loader: ContextLoader | None = None
    gap_detector: KnowledgeGapDetector | None = None
    strategies: list = field(default_factory=list)


def build_default_deps(
    *,
    store: ResearchStore,
    km,
    executor: ResearchExecutor,
    config: ResearchConfig | None = None,
    bus: EventBus | None = None,
    llm_candidate_generator=None,
) -> Deps:
    """Compose the standard module set. This is the one place the concrete
    modules are named; everything downstream depends on interfaces."""
    config = config or ResearchConfig.from_env()
    bus = bus or EventBus()
    strategies = build_strategies(executor, config.strategies or None)
    selector = WeightedStrategySelector(strategies, default_name=DEFAULT_STRATEGY)
    prioritizer = PRIORITIZER_REGISTRY.get(DEFAULT_PRIORITIZER)
    analyzer = ANALYZER_REGISTRY.get(DEFAULT_ANALYZER)
    evaluator = EVALUATOR_REGISTRY.get(DEFAULT_EVALUATOR)
    deps = Deps(
        store=store,
        km=km,
        config=config,
        bus=bus,
        executor=executor,
        candidate_generator=GapBasedCandidateGenerator(llm_generator=llm_candidate_generator),
        candidate_evaluator=HeuristicCandidateEvaluator(),
        prioritizer=prioritizer,
        planner=DefaultResearchPlanner(selector),
        analyzer=analyzer,
        updater=KnowledgeManagerUpdater(km),
        progress_evaluator=ProgressEvaluator(min_useful_info_gain=config.min_useful_info_gain),
        next_action=DefaultNextActionSelector(),
        evaluator=evaluator,
        strategies=strategies,
    )
    # deps-bound modules (they need the full bundle, so built after it exists)
    deps.context_loader = DefaultContextLoader(deps)
    deps.gap_detector = DefaultGapDetector(deps)
    return deps


class ResearchLoop:
    def __init__(self, deps: Deps):
        self.deps = deps
        self._lease_owner = M.new_id("worker_")

    # ── lifecycle API (spec §4) ─────────────────────────────────────────────
    async def start(self, input_: dict) -> M.ResearchRun:
        """Create a run. Does not drive it; `step()`/`advance()` (or the runner)
        move it forward, so the run persists immediately and can be resumed."""
        objective = input_.get("objective") or ""
        o = M.Objective(
            statement=objective if isinstance(objective, str) else str(objective),
            success_criteria=list(input_.get("success_criteria", []) or []),
            domain=input_.get("domain", ""),
        )
        budget = M.Budget.from_dict(input_.get("budget")) if isinstance(input_.get("budget"), dict) else M.Budget()
        # env/config overrides for this run
        cfg = self.deps.config
        if cfg.max_iterations and budget.max_iterations is None:
            budget.max_iterations = cfg.max_iterations
        run = M.ResearchRun(
            id=input_.get("id") or M.new_id("run_"),
            objective=o,
            status=M.RUN_RUNNING,
            stage=M.STAGE_IDLE,
            budget=budget,
            parent_run_id=input_.get("parent_run_id"),
            agent_id=input_.get("agent_id", ""),
            metadata={"branches": {"main": {"parent": None, "depth": 0, "focus": o.statement}}, "active_branch": "main"},
        )
        if isinstance(input_.get("metadata"), dict):
            run.metadata.update(input_["metadata"])
        # Persist the config this run was created with, so a *fresh process* that
        # resumes it (after a restart) rebuilds the same executor + loop knobs
        # instead of silently falling back to env defaults (which is how a 5000-
        # iteration run was killed at the default cap of 50). See
        # `ResearchService.loop_for`, which reads this back.
        run.metadata["seed_config"] = {
            "executor": self.deps.executor.seed_config(),
            "research": self.deps.config.to_dict(),
        }
        await self.deps.store.save_run(run)
        await self._emit(run, E.RESEARCH_STARTED, objective=o.statement, successCriteria=o.success_criteria)
        return run

    async def resume(self, run_id: str) -> M.ResearchRun:
        async with _lock_for(run_id):
            run = await self._load(run_id)
            if run.is_terminal():
                return run
            if run.status in (M.RUN_PAUSED, M.RUN_WAITING):
                run.status = M.RUN_RUNNING
                # a WAITING run resumes at the decision stage it paused before
                if run.stage == M.STAGE_WAITING:
                    run.stage = M.STAGE_DECIDING_NEXT_ACTION
                run.updated_at = M.now_ms()
                await self.deps.store.save_run(run)
                await self._emit(run, E.RESEARCH_RESUMED, stage=run.stage)
            return run

    async def pause(self, run_id: str, *, stage: str | None = None) -> M.ResearchRun:
        async with _lock_for(run_id):
            run = await self._load(run_id)
            if run.is_terminal():
                return run
            run.status = M.RUN_PAUSED
            if stage:
                run.stage = stage
            run.updated_at = M.now_ms()
            await self.deps.store.save_run(run)
            await self._emit(run, E.RESEARCH_PAUSED, stage=run.stage)
            return run

    async def cancel(self, run_id: str) -> M.ResearchRun:
        # Take the same per-run lock `step()` holds. Without it, a cancel that
        # lands while a step is mid-flight is clobbered: the step reloaded the run
        # before the cancel and writes its own copy back at the end, resurrecting
        # the run as RUNNING. Serialising them makes the cancel stick.
        async with _lock_for(run_id):
            run = await self._load(run_id)
            if run.is_terminal():
                return run
            run.status = M.RUN_CANCELLED
            run.stage = M.STAGE_DONE
            run.termination_reason = M.STOP_USER_CANCELLED
            run.completed_at = M.now_ms()
            run.updated_at = run.completed_at
            await self.deps.store.save_run(run)
            await self._emit(run, E.RESEARCH_CANCELLED)
            return run

    # ── stepping ────────────────────────────────────────────────────────────
    async def step(self, run_id: str) -> ResearchStepResult:
        """Run one stage transition under the process-global run lock + lease."""
        lock = _lock_for(run_id)
        async with lock:
            run = await self._load(run_id)
            if run.is_terminal():
                # Note: do NOT pop `_RUN_LOCKS[run_id]` here. Popping the entry
                # while still holding the lock means a caller arriving afterwards
                # builds a *fresh* lock and can run concurrently with a waiter that
                # still holds the old one, breaking mutual exclusion. The dict is
                # bounded by the number of runs this process sees — acceptable.
                return ResearchStepResult(run_id, run.stage, run.stage, run.status, run.iteration, run.current_iteration_id, done=True)
            if run.status in (M.RUN_PAUSED, M.RUN_WAITING):
                return ResearchStepResult(run_id, run.stage, run.stage, run.status, run.iteration, run.current_iteration_id, done=False, output={"paused": True})
            if not self._acquire_lease(run):
                return ResearchStepResult(run_id, run.stage, run.stage, run.status, run.iteration, run.current_iteration_id, done=False, output={"leased": True})
            # Persist the lease BEFORE doing any work, so a competing process
            # (which holds its own in-memory copy) can see we are driving this run.
            await self.deps.store.save_run(run)
            stage_before = run.stage
            try:
                from ..knowledge import vault_store

                # A run's knowledge writes land in its own workspace; it reads
                # through to the vault, so it still sees all prior knowledge.
                with vault_store.staging(_workspace_for(run.id)):
                    await self._run_stage(run)
            finally:
                self._release_lease(run)
                run.updated_at = M.now_ms()
                await self.deps.store.save_run(run)
            if run.is_terminal() and not run.metadata.get("workspace_promoted"):
                # run is done — move its vetted notes into the shared vault
                run.metadata["workspace_promoted"] = _promote_workspace(run.id, log)
                await self.deps.store.save_run(run)
            if run.stage != stage_before:
                await self._emit(run, E.STAGE_CHANGED, **{"from": stage_before, "to": run.stage})
            return ResearchStepResult(
                run_id,
                stage_before,
                run.stage,
                run.status,
                run.iteration,
                run.current_iteration_id,
                done=run.is_terminal(),
            )

    async def advance(self, run_id: str, *, max_steps: int = 200) -> M.ResearchRun:
        """Step until the run is terminal, paused, waiting, or the step cap is hit."""
        for _ in range(max_steps):
            res = await self.step(run_id)
            if res.done or res.status in (M.RUN_PAUSED, M.RUN_WAITING):
                break
        return await self._load(run_id)

    # ── stage dispatch ──────────────────────────────────────────────────────
    async def _run_stage(self, run: M.ResearchRun) -> None:
        handler = {
            M.STAGE_IDLE: self._stage_begin_iteration,
            M.STAGE_LOADING_CONTEXT: self._stage_load_context,
            M.STAGE_ANALYZING_KNOWLEDGE: self._stage_analyze_knowledge,
            M.STAGE_GENERATING_CANDIDATES: self._stage_generate_candidates,
            M.STAGE_PRIORITIZING: self._stage_prioritize,
            M.STAGE_PLANNING: self._stage_plan,
            M.STAGE_EXECUTING: self._stage_execute,
            M.STAGE_COLLECTING_EVIDENCE: self._stage_collect_evidence,
            M.STAGE_ANALYZING_RESULT: self._stage_analyze_result,
            M.STAGE_UPDATING_KNOWLEDGE: self._stage_update_knowledge,
            M.STAGE_EVALUATING_PROGRESS: self._stage_evaluate_progress,
            M.STAGE_DECIDING_NEXT_ACTION: self._stage_decide,
            M.STAGE_WAITING: self._stage_waiting,
        }.get(run.stage, self._stage_begin_iteration)
        await handler(run)

    # each stage: do work, persist, set run.stage = next
    async def _stage_begin_iteration(self, run: M.ResearchRun) -> None:
        # A pre-iteration boundary check for the *hard* limits only (iteration /
        # time). The value-based conditions (diminishing returns, objective,
        # no-research) need an iteration's result, so they are evaluated later —
        # checking them here would fire before the first iteration has produced
        # anything to judge.
        pre = self._pre_iteration_stop(run)
        if pre is not None:
            run.status = M.RUN_COMPLETED
            run.stage = M.STAGE_DONE
            run.termination_reason = pre.reason
            run.completed_at = M.now_ms()
            await self._emit(run, E.RESEARCH_COMPLETED, reason=pre.reason, progress=run.progress.to_dict())
            return
        branch = run.metadata.get("active_branch", "main")
        it = M.ResearchIteration(id=M.new_id("iter_"), run_id=run.id, index=run.iteration, branch=branch)
        run.current_iteration_id = it.id
        run.current_candidate_id = None
        # clear last iteration's evaluation outputs so a failed evaluation this
        # cycle cannot leave a stale recommendation to be acted on
        run.metadata.pop("research_recommendation", None)
        run.metadata.pop("research_evaluation", None)
        await self.deps.store.save_iteration(it)
        run.stage = M.STAGE_LOADING_CONTEXT
        await self._emit(run, E.ITERATION_STARTED, index=run.iteration, branch=branch)

    def _pre_iteration_stop(self, run: M.ResearchRun):
        from .stop import Blocked, IterationLimit, TimeLimit, TokenBudget, ToolCallBudget, UserCancelled

        state = StopState(run=run, config=self.deps.config)
        for cond in (IterationLimit(), TimeLimit(), TokenBudget(), ToolCallBudget(), UserCancelled(), Blocked()):
            decision = cond.check(state)
            if decision is not None:
                return decision
        return None

    async def _stage_load_context(self, run: M.ResearchRun) -> None:
        branch = run.metadata.get("active_branch", "main")
        ctx = await self.deps.context_loader.load(run, iteration=run.iteration, branch=branch)
        ctx.extra["min_useful_info_gain"] = self.deps.config.min_useful_info_gain
        run.metadata["context"] = {
            "objective": ctx.objective.to_dict(),
            "relevant": ctx.relevant,
            "knowledge_text": ctx.knowledge_text,
            "open_unknowns": ctx.open_unknowns,
            "branch": ctx.branch,
            "domain": ctx.domain,
        }
        run.stage = M.STAGE_ANALYZING_KNOWLEDGE
        await self._emit(run, E.CONTEXT_LOADED, index=run.iteration, **ctx.brief())

    async def _stage_analyze_knowledge(self, run: M.ResearchRun) -> None:
        ctx = await self._ctx(run)
        gaps = await self.deps.gap_detector.detect(ctx)
        run.metadata["gaps"] = gaps
        run.metadata["open_gaps"] = len(gaps)
        run.stage = M.STAGE_GENERATING_CANDIDATES
        await self._emit(run, E.KNOWLEDGE_ANALYZED, index=run.iteration, gapCount=len(gaps),
                         kinds=sorted({g.get("kind", "") for g in gaps}))

    async def _stage_generate_candidates(self, run: M.ResearchRun) -> None:
        ctx = await self._ctx(run)
        pending = run.metadata.pop("pending_candidate_id", None)
        if pending:
            cand = await self.deps.store.get_candidate(pending)
            cands = [cand] if cand else []
        else:
            gaps = run.metadata.get("gaps", [])
            cands = await self.deps.candidate_generator.generate(gaps, ctx, run)
            cands = await self.deps.candidate_evaluator.evaluate(cands, ctx)
            # Drop questions this run has already recorded (any status): the
            # generator re-derives them from the run's own unknowns every cycle,
            # so without this the candidate table grows without bound.
            from .candidates import dedup_against_known

            known = await self.deps.store.candidate_question_keys(run.id)
            cands = dedup_against_known(cands, known)
        await self.deps.store.save_candidates(run.id, cands)
        run.metadata["candidate_count"] = len(cands)
        run.stage = M.STAGE_PRIORITIZING
        await self._emit(run, E.CANDIDATES_GENERATED, index=run.iteration, count=len(cands),
                         questions=[c.question for c in cands[:6]])

    async def _stage_prioritize(self, run: M.ResearchRun) -> None:
        ctx = await self._ctx(run)
        # Newest first: the fresh candidates are the point of this cycle. Ordering
        # oldest-first under a limit starved every new candidate once the open pool
        # exceeded the limit (the pool never drains — nothing retires the losers).
        cands = await self.deps.store.list_candidates(run.id, status="open", newest_first=True)
        # Drop questions already researched to the attempt cap, so the loop cannot
        # re-select the same question forever off its own recycled duplicates.
        from .candidates import question_key

        cap = self.deps.config.max_attempts_per_question
        tried: dict[str, int] = {}
        for a in ctx.recent_attempts:
            k = a.get("question_norm", "")
            tried[k] = tried.get(k, 0) + 1
        cands = [c for c in cands if tried.get(question_key(c.question), 0) < cap]
        ranked = await self.deps.prioritizer.rank(cands, ctx)
        if not ranked:
            run.metadata["no_candidates"] = True
            run.stage = M.STAGE_DECIDING_NEXT_ACTION
            await self._emit(run, E.PROGRESS_EVALUATED, index=run.iteration, note="no candidates to prioritise")
            return
        best = ranked[0]
        run.current_candidate_id = best.candidate.id
        await self.deps.store.set_candidate_fields(best.candidate.id, status="selected", priority=best.score,
                                                   rank_inputs=best.candidate.rank_inputs)
        # The chosen question is researched exactly once this cycle: retire its
        # duplicate open rows so they cannot be re-selected next iteration.
        await self.deps.store.retire_duplicate_candidates(run.id, question_key(best.candidate.question), best.candidate.id)
        # keep the ranked breakdown for debug/observability
        run.metadata["last_ranking"] = [r.to_dict() for r in ranked[:5]] if self.deps.config.debug else None
        run.stage = M.STAGE_PLANNING
        await self._emit(run, E.CANDIDATE_SELECTED, index=run.iteration, candidateId=best.candidate.id,
                         question=best.candidate.question, score=round(best.score, 3),
                         breakdown=best.breakdown if self.deps.config.debug else None)

    async def _stage_plan(self, run: M.ResearchRun) -> None:
        ctx = await self._ctx(run)
        cand = await self.deps.store.get_candidate(run.current_candidate_id or "")
        if cand is None:
            run.metadata["no_candidates"] = True
            run.stage = M.STAGE_DECIDING_NEXT_ACTION
            return
        plan, strategy = await self.deps.planner.plan(cand, ctx, run)
        await self.deps.store.save_plan(run.id, plan)
        it = await self._current_iteration(run)
        if it:
            it.plan_id = plan.id
            it.strategy = strategy.name
            it.hypothesis = cand.question
            it.candidate_id = cand.id
            await self.deps.store.save_iteration(it)
        run.metadata["current_plan_id"] = plan.id
        run.stage = M.STAGE_EXECUTING
        await self._emit(run, E.PLAN_CREATED, index=run.iteration, strategy=strategy.name,
                         planId=plan.id, steps=plan.steps)

    async def _stage_execute(self, run: M.ResearchRun) -> None:
        ctx = await self._ctx(run)
        plan = await self.deps.store.get_plan(run.metadata.get("current_plan_id", ""))
        if plan is None:
            run.metadata["no_candidates"] = True
            run.stage = M.STAGE_DECIDING_NEXT_ACTION
            return
        await self._emit(run, E.EXECUTION_STARTED, index=run.iteration, strategy=plan.strategy, planId=plan.id)
        result = await self.deps.executor.execute(plan, ctx, run)
        result.iteration_id = run.current_iteration_id or ""
        await self.deps.store.save_result(run.id, result)
        run.metadata["current_result_id"] = result.id
        # account for the tool calls this execution reported
        tc = int((result.cost or {}).get("tool_calls", 0) or 0)
        if tc:
            run.metadata["tool_calls_used"] = int(run.metadata.get("tool_calls_used", 0)) + tc
        run.stage = M.STAGE_COLLECTING_EVIDENCE

    async def _stage_collect_evidence(self, run: M.ResearchRun) -> None:
        # evidence already lives on the result; this stage normalises/counts it so
        # the boundary is explicit and swappable (a collector could enrich here).
        result = await self.deps.store.get_result(run.metadata.get("current_result_id", ""))
        count = len(result.evidence or []) if result else 0
        run.stage = M.STAGE_ANALYZING_RESULT
        await self._emit(run, E.EVIDENCE_COLLECTED, index=run.iteration, count=count)

    async def _stage_analyze_result(self, run: M.ResearchRun) -> None:
        ctx = await self._ctx(run)
        result = await self.deps.store.get_result(run.metadata.get("current_result_id", ""))
        # A missing result is a transient failure (the executor wrote nothing),
        # not a silent no-op: FAIL_NONE made nextaction read it as a non-transient
        # failure and CONTINUE, dropping the iteration as if it had succeeded.
        evaluation = (
            self.deps.analyzer.analyze(result, ctx)
            if result
            else M.Evaluation(failed=True, failure_kind=M.FAIL_TOOL)
        )
        run.metadata["evaluation"] = evaluation.to_dict()
        it = await self._current_iteration(run)
        if it:
            it.result_id = result.id if result else None
            it.evaluation = evaluation.to_dict()
            it.disposition = "FAILED" if evaluation.failed else "ANALYZED"
            await self.deps.store.save_iteration(it)
        run.stage = M.STAGE_UPDATING_KNOWLEDGE
        await self._emit(run, E.RESULT_CREATED, index=run.iteration,
                         failed=evaluation.failed, infoGain=evaluation.info_gain)

    async def _stage_update_knowledge(self, run: M.ResearchRun) -> None:
        result = await self.deps.store.get_result(run.metadata.get("current_result_id", ""))
        evaluation = M.Evaluation.from_dict(run.metadata.get("evaluation", {}))
        updates: list[dict] = []
        if result is not None:
            # When the candidate targets a known conflict, its findings are recorded
            # *against* that conflict rather than as a fresh claim — without this the
            # manager's conflict path never fires (contradicts was always None).
            cand = await self.deps.store.get_candidate(run.current_candidate_id or result.candidate_id or "")
            conflict_targets = list(cand.related_conflicts) if cand else []
            updates = await self.deps.updater.update(result, evaluation, run, conflict_targets=conflict_targets)
        run.metadata["knowledge_updates"] = updates
        it = await self._current_iteration(run)
        if it:
            it.knowledge_updates = updates
            await self.deps.store.save_iteration(it)
        run.stage = M.STAGE_EVALUATING_PROGRESS
        await self._emit(run, E.KNOWLEDGE_UPDATED, index=run.iteration, updates=updates)

    async def _stage_evaluate_progress(self, run: M.ResearchRun) -> None:
        evaluation = M.Evaluation.from_dict(run.metadata.get("evaluation", {}))
        updates = run.metadata.get("knowledge_updates", [])
        run.progress = self.deps.progress_evaluator.apply(run.progress, evaluation, updates)
        run.metadata["coverage"] = await self._objective_coverage(run)

        # the Research Evaluator — the decision-support layer. It reads the whole
        # iteration (result, plan, candidate, knowledge deltas, prior evaluations,
        # the attempt ledger) and returns a structured evaluation whose
        # recommendation the decision stage consumes.
        ev = await self._evaluate_iteration(run)
        if ev is not None:
            run.metadata["research_evaluation"] = ev.to_dict()
            run.metadata["research_recommendation"] = ev.recommendation
            it = await self._current_iteration(run)
            if it:
                it.evaluation = {**it.evaluation, "research": ev.summary()}
                await self.deps.store.save_iteration(it)
            await self._emit(run, E.RESEARCH_EVALUATED, index=run.iteration,
                             status=ev.status, signals=ev.signal_names(),
                             recommendation=ev.recommendation.get("action"),
                             evidenceQuality=round(ev.evidence_quality, 3),
                             knowledgeGain=round(ev.knowledge_gain, 3))

        run.stage = M.STAGE_DECIDING_NEXT_ACTION
        await self._emit(run, E.PROGRESS_EVALUATED, index=run.iteration,
                         infoGain=evaluation.info_gain, lowValueStreak=run.progress.low_value_streak,
                         coverage=round(run.metadata["coverage"], 3), progress=run.progress.to_dict())

    async def _evaluate_iteration(self, run: M.ResearchRun):
        """Assemble the evaluator's input from persisted state and run it."""
        try:
            ctx = await self._ctx(run)
            result = await self.deps.store.get_result(run.metadata.get("current_result_id", ""))
            plan = await self.deps.store.get_plan(run.metadata.get("current_plan_id", ""))
            cand = await self.deps.store.get_candidate(run.current_candidate_id or "")
            attempts = await self.deps.store.all_attempts(run.id)
            prior = [EModel.ResearchEvaluation.from_row(r)
                     for r in await self.deps.store.list_evaluations(run.id)]
            inp = EvaluationInput(
                run=run,
                objective=run.objective,
                ctx=ctx,
                iteration_id=run.current_iteration_id or "",
                candidate=cand,
                plan=plan,
                result=result,
                knowledge_updates=run.metadata.get("knowledge_updates", []),
                prior_evaluations=prior,
                attempts=attempts,
                debug=self.deps.config.debug,
                max_attempts=self.deps.config.max_attempts_per_question,
            )
            ev = await self.deps.evaluator.evaluate(inp)
            await self.deps.store.save_evaluation(ev)
            return ev
        except Exception:
            log.exception("research evaluation failed for run %s", run.id)
            return None

    async def _stage_decide(self, run: M.ResearchRun) -> None:
        evaluation = M.Evaluation.from_dict(run.metadata.get("evaluation", {}))
        # attempts and failures on the *current question* (not the run as a whole):
        # `repeated-failure` compares against a per-question cap, so feeding it the
        # run-wide low-value streak let an unrelated plateau trip it with a reason
        # that named the wrong question.
        attempts = 0
        question_failures = 0
        if run.current_candidate_id:
            cand = await self.deps.store.get_candidate(run.current_candidate_id)
            if cand:
                from .candidates import question_key

                rows = await self.deps.store.find_attempts(run.id, question_key(cand.question))
                attempts = len(rows)
                for r in rows:  # rows are newest-first
                    if r.get("outcome") == "failed":
                        question_failures += 1
                    else:
                        break
        stop = evaluate_stops(
            StopState(
                run=run,
                config=self.deps.config,
                candidate_count=int(run.metadata.get("candidate_count", 0)),
                coverage=float(run.metadata.get("coverage", 0.0)),
                open_gaps=int(run.metadata.get("open_gaps", 0)),
                consecutive_failures=question_failures,
                last_evaluation=evaluation,
            )
        )
        branch = run.metadata.get("active_branch", "main")
        depth = run.metadata.get("branches", {}).get(branch, {}).get("depth", 0)
        action = self.deps.next_action.select(
            evaluation=evaluation,
            stop=stop,
            run=run,
            attempts_on_question=attempts,
            max_attempts=self.deps.config.max_attempts_per_question,
            branch_depth=depth,
            max_branch_depth=self.deps.config.max_branch_depth,
            recommendation=run.metadata.get("research_recommendation"),
        )
        it = await self._current_iteration(run)
        if it:
            it.next_action = action.action
            it.next_reason = action.reason
            it.stage = M.STAGE_DECIDING_NEXT_ACTION
            it.finished_at = M.now_ms()
            await self.deps.store.save_iteration(it)
        await self._emit(run, E.NEXT_ACTION_SELECTED, index=run.iteration, action=action.action, reason=action.reason)

        if action.action == M.ACTION_STOP:
            run.status = M.RUN_COMPLETED
            run.stage = M.STAGE_DONE
            run.termination_reason = action.reason
            run.completed_at = M.now_ms()
            await self._emit(run, E.RESEARCH_COMPLETED, reason=action.reason, progress=run.progress.to_dict())
            return
        if action.action == M.ACTION_WAIT:
            run.status = M.RUN_WAITING
            run.stage = M.STAGE_WAITING
            run.metadata["wait_reason"] = action.reason
            return
        if action.action == M.ACTION_RETRY:
            run.metadata["pending_candidate_id"] = run.current_candidate_id
            await self._record_attempt(run, evaluation, outcome="failed")
        elif action.action == M.ACTION_BRANCH:
            self._create_branch(run, action)
            await self._record_attempt(run, evaluation, outcome="branched")
        else:
            await self._record_attempt(run, evaluation, outcome="done" if not evaluation.failed else "failed")

        # begin the next iteration
        run.iteration += 1
        run.stage = M.STAGE_IDLE

    async def _stage_waiting(self, run: M.ResearchRun) -> None:
        return  # nothing advances a WAITING run but resume()

    # ── helpers ─────────────────────────────────────────────────────────────
    async def _load(self, run_id: str) -> M.ResearchRun:
        run = await self.deps.store.get_run(run_id)
        if run is None:
            raise KeyError(f"no research run {run_id!r}")
        return run

    async def _current_iteration(self, run: M.ResearchRun) -> M.ResearchIteration | None:
        if not run.current_iteration_id:
            return None
        return await self.deps.store.get_iteration(run.current_iteration_id)

    async def _ctx(self, run: M.ResearchRun) -> ResearchContext:
        """Rebuild the iteration's ResearchContext from persisted metadata (the
        loader ran once at LOADING_CONTEXT; later stages read its output rather
        than re-querying the graph)."""
        stored = run.metadata.get("context", {})
        objective = M.Objective.from_dict(stored.get("objective", {"statement": run.objective.statement}))
        attempts = await self.deps.store.all_attempts(run.id)
        ctx = ResearchContext(
            run_id=run.id,
            objective=objective,
            iteration=run.iteration,
            domain=stored.get("domain", ""),
            relevant=stored.get("relevant", []),
            knowledge_text=stored.get("knowledge_text", ""),
            gaps=run.metadata.get("gaps", []),
            open_unknowns=stored.get("open_unknowns", []),
            branch=stored.get("branch", run.metadata.get("active_branch", "main")),
            recent_attempts=attempts,
            debug=self.deps.config.debug,
        )
        ctx.extra["min_useful_info_gain"] = self.deps.config.min_useful_info_gain
        return ctx

    async def _objective_coverage(self, run: M.ResearchRun) -> float:
        """Fraction of the objective's keywords covered by a knowledge node. A
        coarse but honest signal for the objective-satisfied stop condition."""
        from .gaps import _keywords

        terms = _keywords(run.objective.statement)
        for c in run.objective.success_criteria:
            terms |= _keywords(c)
        if not terms:
            return 0.0
        try:
            from ..knowledge import index as kix

            idx = kix.get()
            covered: set[str] = set()
            for slug, node in idx.nodes.items():
                covered |= _keywords(slug) | _keywords(node.title)
        except Exception:  # noqa: BLE001
            return 0.0
        return len(terms & covered) / len(terms)

    async def _record_attempt(self, run: M.ResearchRun, evaluation: M.Evaluation, *, outcome: str) -> None:
        cand = await self.deps.store.get_candidate(run.current_candidate_id or "")
        if cand is None:
            return
        from .candidates import question_key

        plan = await self.deps.store.get_plan(run.metadata.get("current_plan_id", ""))
        await self.deps.store.record_attempt({
            "run_id": run.id,
            "candidate_id": cand.id,
            "question_norm": question_key(cand.question),
            "strategy": plan.strategy if plan else "",
            "outcome": outcome,
            "failure_kind": evaluation.failure_kind,
            "info_gain": evaluation.info_gain,
        })

    def _create_branch(self, run: M.ResearchRun, action: NextAction) -> None:
        slug = "".join(ch.lower() if ch.isalnum() else "-" for ch in (action.branch or "branch")).strip("-")[:40] or "branch"
        branches = run.metadata.setdefault("branches", {"main": {"parent": None, "depth": 0, "focus": ""}})
        if slug not in branches:
            parent = run.metadata.get("active_branch", "main")
            depth = branches.get(parent, {}).get("depth", 0) + 1
            branches[slug] = {"parent": parent, "depth": depth, "focus": action.focus or action.branch, "created_at": M.now_ms()}
        run.metadata["active_branch"] = slug
        run.metadata["branch_focus"] = action.focus or action.branch

    # ── lease (cross-process safety, §34) ───────────────────────────────────
    def _acquire_lease(self, run: M.ResearchRun) -> bool:
        lease = run.metadata.get("lease")
        now = M.now_ms()
        if lease and lease.get("owner") != self._lease_owner and int(lease.get("expires", 0)) > now:
            return False  # another live worker holds it
        run.metadata["lease"] = {"owner": self._lease_owner, "expires": now + LEASE_TTL_MS}
        return True

    def _release_lease(self, run: M.ResearchRun) -> None:
        lease = run.metadata.get("lease")
        if lease and lease.get("owner") == self._lease_owner:
            run.metadata.pop("lease", None)

    # ── events ──────────────────────────────────────────────────────────────
    async def _emit(self, run: M.ResearchRun, type_: str, *, index: int | None = None, **data: Any) -> None:
        ev = make_event(run.id, type_, iteration_index=index, **data)
        self.deps.bus.publish(ev)
        try:
            await self.deps.store.record_event(ev)
        except Exception:
            log.exception("event persist failed for %s", type_)
