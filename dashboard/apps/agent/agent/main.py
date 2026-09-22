"""FastAPI entrypoint for the agent service.

`POST /run` takes the config payload the backend resolved and streams back our
SSE envelope protocol (identical to the old Node chat-engine, plus an `interrupt`
envelope when a run pauses for approval). `GET /state/{thread_id}` reports the
pending interrupt for a session, so the UI can re-surface it after a reload.
`GET /health` is a readiness probe.
"""

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .checkpointer import close_checkpointer, get_checkpointer, init_checkpointer
from .config import agent_port
from .control import list_history, rewind_to
from .graph import stream_run
from .models import RunRequest
from .research import models as RM
from .research.service import close_research_service, get_research_service, init_research_service
from .research.store import close_research_store, init_research_store
from .spawn_log import list_spawns
from .spawns import extract_spawns
from .sse import frame, keepalive
from .store import close_store, init_store

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

log = logging.getLogger("agent.main")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """Open the checkpoint store (thread state), the memory store (cross-session
    facts), and the research store + service (the Research Loop's durable state
    and background driver) for the life of the process."""
    await init_checkpointer()
    await init_store()
    await init_research_store()
    await init_research_service()
    try:
        yield
    finally:
        await close_research_service()
        await close_research_store()
        await close_checkpointer()
        await close_store()


app = FastAPI(title="dashboard-agent", version="0.1.0", lifespan=lifespan)


@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}


# Emit an SSE comment frame when the run goes quiet for this long. A tool round
# (especially a sub-agent, which makes its own model calls and fetches) can
# leave the stream silent for minutes, and an idle stream gets dropped by an
# intermediary's timeout on the way to the client. See sse.keepalive().
KEEPALIVE_INTERVAL_S = 10.0
# How many durable events a fresh SSE attach replays before going live. A run can
# far exceed this; we replay the most recent window and emit a truncation marker.
REPLAY_LIMIT = 2000


async def _with_keepalive(source: AsyncIterator[dict], interval: float = KEEPALIVE_INTERVAL_S) -> AsyncIterator[bytes]:
    """Yield SSE frames from `source`, emitting a keepalive whenever it is silent
    for `interval` seconds.

    The in-flight `__anext__` runs as a Task we hold open across ticks, so a
    keepalive never cancels the pending LangGraph step (a bare `wait_for` would,
    aborting the run mid-tool). The task is cancelled only when the client
    disconnects or the response is torn down.
    """
    aiter = source.__aiter__()
    pending: asyncio.Task | None = None
    try:
        while True:
            if pending is None:
                pending = asyncio.ensure_future(aiter.__anext__())
            done, _ = await asyncio.wait({pending}, timeout=interval)
            if not done:
                yield keepalive()
                continue
            task = done.pop()
            pending = None
            try:
                envelope = task.result()
            except StopAsyncIteration:
                break
            yield frame(envelope)
    finally:
        if pending is not None and not pending.done():
            pending.cancel()
            with suppress(asyncio.CancelledError):
                await pending


@app.post("/run")
async def run(req: RunRequest) -> StreamingResponse:
    async def body():
        try:
            async for chunk in _with_keepalive(stream_run(req)):
                yield chunk
        except Exception as err:  # noqa: BLE001 — never leak a raw traceback as the body
            yield frame({"type": "error", "message": str(err)})
            yield frame({"type": "done"})

    return StreamingResponse(
        body(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no"},
    )


@app.get("/state/{thread_id}")
async def state(thread_id: str) -> dict:
    """The pending approval interrupt for a thread, if the run is paused.

    A paused run leaves its interrupt as a write to the `__interrupt__` channel
    on the latest checkpoint, so we read it straight from the saver — no graph
    needed. Used by the UI to re-surface an approval after a reload.
    """
    saver = get_checkpointer()
    slot = await saver.aget_tuple({"configurable": {"thread_id": thread_id}})
    if slot is None:
        return {"paused": False, "interrupt": None}
    for _task_id, channel, value in slot.pending_writes or []:
        if channel != "__interrupt__":
            continue
        interrupts = value if isinstance(value, (list, tuple)) else [value]
        if not interrupts:
            continue
        intr = interrupts[0]
        payload = getattr(intr, "value", None)
        payload = payload if isinstance(payload, dict) else {}
        return {
            "paused": True,
            "interrupt": {
                "id": getattr(intr, "id", None),
                "tool": payload.get("tool"),
                "args": payload.get("args", {}),
                "message": payload.get("message", "Approval required."),
                # The policy this paused run is being asked under. Persisted in
                # the interrupt value, so a reload reconstructs the HISTORICAL
                # mode rather than the session's current one.
                "mode": payload.get("permission", "ask"),
            },
        }
    return {"paused": False, "interrupt": None}


@app.delete("/thread/{thread_id}")
async def delete_thread(thread_id: str) -> dict:
    """Drop a thread's durable checkpoint so its next run starts fresh.

    The backend calls this when the operator regenerates a reply or edits an
    earlier turn: the message tail is rewound in SQLite, and without clearing
    the checkpoint the graph would keep appending to stale state instead of
    re-seeding from the rewound transcript. Best-effort — a thread with no
    checkpoint is already clean, so `adelete_thread` on a missing id is a no-op.
    """
    await get_checkpointer().adelete_thread(thread_id)
    return {"ok": True}


@app.get("/spawns/{thread_id}")
async def spawns(thread_id: str) -> dict:
    """The sub-agents this orchestrator thread has spawned, in order.

    Timestamps come from the spawn log (the checkpoint records only *that* a
    spawn happened). For threads predating the log, we fall back to reading the
    spawns straight out of the checkpoint.
    """
    logged = await list_spawns(thread_id)
    if logged:
        return {"spawns": logged}

    saver = get_checkpointer()
    slot = await saver.aget_tuple({"configurable": {"thread_id": thread_id}})
    if slot is None:
        return {"spawns": []}
    messages = slot.checkpoint.get("channel_values", {}).get("messages", [])
    return {"spawns": extract_spawns(messages)}


@app.get("/history/{thread_id}")
async def history(thread_id: str, limit: int = 50) -> dict:
    """A thread's saved checkpoints, newest first — one entry per step the run
    graph took. Drives the UI's step timeline and the rewind picker."""
    steps = await list_history(thread_id, limit=max(1, min(limit, 500)))
    return {"steps": steps}


class RewindBody(BaseModel):
    checkpointId: str


@app.post("/rewind/{thread_id}")
async def rewind(thread_id: str, body: RewindBody) -> dict:
    """Fork a thread back to a past checkpoint (time travel). Everything after it
    is dropped; the next `/run` continues from there. This is checkpoint-level
    rewind — the backend also rewinds its own transcript in step with this."""
    return await rewind_to(thread_id, body.checkpointId)


# ── Research Loop ────────────────────────────────────────────────────────────
# A modular, resumable research engine over the same Markdown knowledge graph.
# These endpoints are the control surface; the loop itself lives in
# agent/research/ and never touches this layer. All are idempotent-safe: a run is
# durable state, and each mutation returns the run's new shape.


class ResearchStartBody(BaseModel):
    objective: str
    success_criteria: list[str] = []
    domain: str = ""
    budget: dict | None = None
    metadata: dict | None = None
    parent_run_id: str | None = None
    agent_id: str = ""
    # Optional per-run overrides: the executor config (LLM creds + tools the
    # backend resolved, same shape as RunRequest) and the loop config.
    config: dict | None = None
    research_config: dict | None = None
    # When true, drive the run in the background immediately after creating it.
    autostart: bool = True


@app.post("/research/runs")
async def research_start(body: ResearchStartBody) -> dict:
    """Create a research run. Optionally starts driving it in the background."""
    svc = get_research_service()
    loop = await svc.loop_for("__pending__", config=body.config, research_config=body.research_config)
    run = await loop.start(
        {
            "objective": body.objective,
            "success_criteria": body.success_criteria,
            "domain": body.domain,
            "budget": body.budget,
            "metadata": body.metadata,
            "parent_run_id": body.parent_run_id,
            "agent_id": body.agent_id,
        }
    )
    # re-key the cached loop under the real id (it was built for the pending key)
    svc._loops.pop("__pending__", None)
    svc._loops[run.id] = loop
    if body.autostart:
        svc.runner.drive(run.id)
    return {"run": run.summary(), "driving": svc.runner.is_running(run.id)}


@app.get("/research/runs")
async def research_list(status: str | None = None, limit: int = 50) -> dict:
    """List research runs, newest first, optionally filtered by status."""
    svc = get_research_service()
    runs = await svc.store.list_runs(status=status, limit=max(1, min(limit, 200)))
    return {"runs": [r.summary() for r in runs], "running": svc.runner.running_ids()}


@app.get("/research/runs/{run_id}")
async def research_get(run_id: str, iterations_limit: int = 20000) -> dict:
    """One run's full state, its iterations, and its open candidates.

    `iterations_limit` bounds the iteration list (a large run can hold thousands);
    `iterationCount` reports the true total so the UI can tell when the list is
    partial rather than silently showing a truncated timeline.
    """
    svc = get_research_service()
    run = await svc.store.get_run(run_id)
    if run is None:
        return {"error": "not found"}
    iterations = await svc.store.list_iterations(run_id, limit=max(1, min(iterations_limit, 50000)))
    candidates = await svc.store.list_candidates(run_id)
    total = await svc.store.count_iterations(run_id)
    return {
        "run": run.summary(),
        "iterations": [it.to_dict() for it in iterations],
        "iterationCount": total,
        "candidates": [c.to_dict() for c in candidates],
        "driving": svc.runner.is_running(run_id),
        "branches": run.metadata.get("branches", {}),
    }


@app.post("/research/runs/{run_id}/step")
async def research_step(run_id: str) -> dict:
    """Advance the run exactly one stage transition (interruptible)."""
    svc = get_research_service()
    if not await svc.store.get_run(run_id):
        return {"error": "not found"}
    loop = await svc.loop_for(run_id)
    res = await loop.step(run_id)
    return {"step": res.to_dict()}


@app.post("/research/runs/{run_id}/advance")
async def research_advance(run_id: str, max_steps: int = 200) -> dict:
    """Drive the run to its next stopping point (foreground, bounded)."""
    svc = get_research_service()
    if not await svc.store.get_run(run_id):
        return {"error": "not found"}
    loop = await svc.loop_for(run_id)
    run = await loop.advance(run_id, max_steps=max_steps)
    return {"run": run.summary()}


@app.post("/research/runs/{run_id}/pause")
async def research_pause(run_id: str) -> dict:
    """Pause a run — it keeps its state and resumes later."""
    svc = get_research_service()
    run = await (await svc.loop_for(run_id)).pause(run_id)
    return {"run": run.summary()}


@app.post("/research/runs/{run_id}/resume")
async def research_resume(run_id: str, autostart: bool = True) -> dict:
    """Resume a paused/waiting run."""
    svc = get_research_service()
    if not await svc.store.get_run(run_id):
        return {"error": "not found"}
    run = await (await svc.loop_for(run_id)).resume(run_id)
    if autostart:
        svc.runner.drive(run_id)
    return {"run": run.summary(), "driving": svc.runner.is_running(run_id)}


@app.post("/research/runs/{run_id}/cancel")
async def research_cancel(run_id: str) -> dict:
    """Cancel a run — terminal; its knowledge stays in the graph."""
    svc = get_research_service()
    run = await (await svc.loop_for(run_id)).cancel(run_id)
    return {"run": run.summary()}


@app.get("/research/runs/{run_id}/iterations")
async def research_iterations(run_id: str, limit: int = 500) -> dict:
    svc = get_research_service()
    its = await svc.store.list_iterations(run_id, limit=max(1, min(limit, 2000)))
    return {"iterations": [it.to_dict() for it in its]}


@app.get("/research/runs/{run_id}/evaluations")
async def research_evaluations(run_id: str, limit: int = 500, lean: bool = False) -> dict:
    """The Research Evaluator's structured output for a run — one entry per
    iteration, each a decision-support record (dimensions, evidence grades,
    contradictions, signals, recommendation).

    `lean=true` returns every evaluation's scalars + small structured fields with
    the heavy arrays (evidence, unknowns, reasoning) collapsed to lengths — so a
    run with thousands of iterations can be filtered and charted in one response.
    """
    svc = get_research_service()
    if lean:
        evs = await svc.store.list_evaluations_lean(run_id, limit=max(1, min(limit, 50000)))
    else:
        evs = await svc.store.list_evaluations(run_id, limit=max(1, min(limit, 2000)))
    return {"evaluations": evs}


@app.get("/research/runs/{run_id}/results")
async def research_results(run_id: str, limit: int = 500) -> dict:
    """Each iteration's executed result: the sub-agent's evidence-first output
    (observations, evidence, conclusions, uncertainties) and its observable
    activity trace (thought / tool_call / tool_result steps).

    The web Timeline pairs each iteration with its result, so a large run needs
    them all (a run can hold thousands of iterations); the default stays modest
    for callers that only want the head.
    """
    svc = get_research_service()
    res = await svc.store.list_results(run_id, limit=max(1, min(limit, 50000)))
    return {"results": res}


@app.get("/research/evaluations/{evaluation_id}")
async def research_evaluation(evaluation_id: str) -> dict:
    """One evaluation in full, including the per-evidence grading and reasoning."""
    svc = get_research_service()
    ev = await svc.store.get_evaluation(evaluation_id)
    if ev is None:
        return {"error": "not found"}
    return {"evaluation": ev}


@app.get("/research/evaluators")
async def research_evaluators() -> dict:
    """The evaluation engine's registers: dimensions, evaluators and recommenders."""
    from .research.evaluator import model as EModel
    from .research.evaluator.base import DIMENSION_REGISTRY
    from .research.evaluator.pipeline import EVALUATOR_REGISTRY
    from .research.evaluator.recommend import RECOMMENDATION_REGISTRY

    return {
        "evaluators": EVALUATOR_REGISTRY.names(),
        "dimensions": DIMENSION_REGISTRY.names(),
        "recommenders": RECOMMENDATION_REGISTRY.names(),
        "statuses": list(EModel.EVAL_STATUSES),
        "evidenceLevels": list(EModel.EVIDENCE_LEVELS),
        "evidenceStrengths": list(EModel.STRENGTH_ORDER.keys()),
        "signals": list(EModel.SIGNAL_NAMES),
    }


# ── Scheduler (the durable temporal execution layer for research runs) ───────

class ScheduleBody(BaseModel):
    """A schedule request. `type` chooses the trigger; the other fields carry its
    spec (cron/interval/at/event/depends_on)."""

    research_run_id: str = ""
    type: str = "IMMEDIATE"
    cron: str = ""
    interval_s: int = 0
    at: str | None = None
    delay_s: int = 0
    event: str = ""
    depends_on: list[str] = []
    dep_condition: str = "COMPLETED"
    timezone: str = ""
    priority: str = "NORMAL"
    retry: dict | None = None
    concurrency: dict | None = None
    resources: dict | None = None
    deadline: str | None = None
    max_runs: int | None = None
    max_runs_per_hour: int = 0
    idempotency_key: str = ""
    created_by: str = "USER"
    metadata: dict | None = None


def _scheduler():
    svc = get_research_service()
    if svc.scheduler is None:
        raise HTTPException(status_code=503, detail="scheduler is disabled")
    return svc.scheduler


@app.post("/scheduler/schedules")
async def scheduler_schedule(body: ScheduleBody) -> dict:
    """Create a durable schedule for a research run (spec §4, §5)."""
    from .research.scheduler import ScheduleRequest

    sch = _scheduler()
    try:
        sched = await sch.schedule(ScheduleRequest(**body.model_dump()))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"schedule": sched.summary()}


@app.get("/scheduler/schedules")
async def scheduler_list_schedules(status: str | None = None, research_run_id: str | None = None) -> dict:
    return {"schedules": await _scheduler().list_schedules(status=status, research_run_id=research_run_id)}


@app.get("/scheduler/schedules/{schedule_id}")
async def scheduler_get_schedule(schedule_id: str) -> dict:
    s = await _scheduler().get_schedule(schedule_id)
    if s is None:
        return {"error": "not found"}
    return {"schedule": s}


@app.post("/scheduler/schedules/{schedule_id}/pause")
async def scheduler_pause_schedule(schedule_id: str) -> dict:
    return {"schedule": await _scheduler().pause_schedule(schedule_id)}


@app.post("/scheduler/schedules/{schedule_id}/resume")
async def scheduler_resume_schedule(schedule_id: str) -> dict:
    return {"schedule": await _scheduler().resume_schedule(schedule_id)}


@app.post("/scheduler/schedules/{schedule_id}/cancel")
async def scheduler_cancel_schedule(schedule_id: str) -> dict:
    return {"schedule": await _scheduler().cancel_schedule(schedule_id)}


@app.get("/scheduler/jobs")
async def scheduler_list_jobs(status: str | None = None, schedule_id: str | None = None,
                              research_run_id: str | None = None, limit: int = 500) -> dict:
    return {"jobs": await _scheduler().list_jobs(status=status, schedule_id=schedule_id,
                                                 research_run_id=research_run_id, limit=limit)}


@app.get("/scheduler/jobs/{job_id}")
async def scheduler_get_job(job_id: str) -> dict:
    sch = _scheduler()
    j = await sch.get_job(job_id)
    if j is None:
        return {"error": "not found"}
    return {"job": j, "explain": await sch.explain(job_id)}


@app.post("/scheduler/jobs/{job_id}/cancel")
async def scheduler_cancel_job(job_id: str) -> dict:
    return {"job": await _scheduler().cancel(job_id)}


@app.post("/scheduler/jobs/{job_id}/pause")
async def scheduler_pause_job(job_id: str) -> dict:
    return {"job": await _scheduler().pause(job_id)}


@app.post("/scheduler/jobs/{job_id}/resume")
async def scheduler_resume_job(job_id: str) -> dict:
    return {"job": await _scheduler().resume(job_id)}


@app.post("/scheduler/jobs/{job_id}/trigger")
async def scheduler_trigger_job(job_id: str) -> dict:
    """Manual trigger — enqueues a fresh job through the normal path (spec §57)."""
    return {"job": await _scheduler().trigger(job_id)}


@app.post("/scheduler/jobs/{job_id}/replay")
async def scheduler_replay_job(job_id: str) -> dict:
    """Replay a terminal job as a new execution (spec §58)."""
    return {"job": await _scheduler().replay(job_id)}


@app.get("/scheduler/dead-letters")
async def scheduler_dead_letters() -> dict:
    return {"jobs": await _scheduler().list_dead_letters()}


@app.post("/scheduler/events/{event_name}")
async def scheduler_notify_event(event_name: str) -> dict:
    """Feed an external event into the trigger matcher (spec §23)."""
    await _scheduler().notify_event(event_name)
    return {"ok": True, "event": event_name}


@app.get("/scheduler/debug")
async def scheduler_debug() -> dict:
    """The scheduler debug view (spec §50): workers, queue, upcoming, running,
    waiting, retrying, dead-letter, resources and metrics."""
    return {"scheduler": await _scheduler().debug_view()}


@app.get("/scheduler/metrics")
async def scheduler_metrics() -> dict:
    return {"metrics": await _scheduler().metrics_snapshot()}


@app.get("/scheduler/registries")
async def scheduler_registries() -> dict:
    """The scheduler's pluggable registers (spec §53)."""
    from .research.scheduler import model as SModel
    from .research.scheduler.policy import SCHEDULING_POLICY_REGISTRY
    from .research.scheduler.recover import RECOVERY_REGISTRY
    from .research.scheduler.retry import RETRY_POLICY_REGISTRY
    from .research.scheduler.triggers import TRIGGER_REGISTRY

    return {
        "scheduleTypes": list(SModel.SCHEDULE_TYPES),
        "jobStatuses": list(SModel.JOB_STATUSES),
        "priorities": list(SModel.PRIORITIES),
        "triggers": TRIGGER_REGISTRY.names(),
        "policies": SCHEDULING_POLICY_REGISTRY.names(),
        "retryStrategies": RETRY_POLICY_REGISTRY.names(),
        "recoveryPolicies": RECOVERY_REGISTRY.names(),
    }


@app.get("/research/runs/{run_id}/events")
async def research_events(run_id: str, since: int = 0, limit: int = 1000) -> dict:
    """The durable event log for a run (observability + UI timeline)."""
    svc = get_research_service()
    evs = await svc.store.list_events(run_id, since_ts=since, limit=max(1, min(limit, 5000)))
    return {"events": evs}


@app.get("/research/runs/{run_id}/stream")
async def research_stream(run_id: str) -> StreamingResponse:
    """Live SSE of a run's events (the same envelope framing the chat streams)."""
    svc = get_research_service()

    async def body():
        q = svc.bus.subscribe(run_id)
        try:
            # Replay the durable log first (so an attach sees history), then live.
            # Replay the most recent window, not the oldest: a run can carry far
            # more than REPLAY_LIMIT events, and an ASC read with a limit returned
            # the head and silently dropped the recent tail. When events were
            # skipped, tell the client explicitly instead of quietly truncating.
            total = await svc.store.count_events(run_id)
            if total > REPLAY_LIMIT:
                yield frame({"research_replay": {"total": total, "sent": REPLAY_LIMIT, "truncated": True}})
            for ev in await svc.store.tail_events(run_id, limit=REPLAY_LIMIT):
                yield frame({"research": ev})
            while True:
                try:
                    ev = await asyncio.wait_for(q.get(), timeout=KEEPALIVE_INTERVAL_S)
                except TimeoutError:
                    yield keepalive()
                    continue
                yield frame({"research": ev.to_dict()})
                if ev.type in ("RESEARCH_COMPLETED", "RESEARCH_CANCELLED", "RESEARCH_FAILED"):
                    break
        finally:
            svc.bus.unsubscribe(run_id, q)
        yield frame({"research_done": True})

    return StreamingResponse(
        body(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no"},
    )


@app.get("/research/health")
async def research_health() -> dict:
    """The knowledge-health report the loop reads gaps from, for the UI."""
    try:
        from .knowledge.manager import default_manager

        return {"knowledge": default_manager().validate_graph()}
    except Exception as err:  # noqa: BLE001
        return {"error": str(err)}


@app.get("/research/strategies")
async def research_strategies() -> dict:
    """The registered strategies, prioritizers and stop conditions (registries)."""
    from .research.prioritizer import PRIORITIZER_REGISTRY
    from .research.stop import STOP_REGISTRY
    from .research.strategies.registry import STRATEGY_REGISTRY

    return {
        "strategies": STRATEGY_REGISTRY.names(),
        "prioritizers": PRIORITIZER_REGISTRY.names(),
        "stop_conditions": STOP_REGISTRY.names(),
        "statuses": sorted(RM.RUN_STATUSES),
        "stages": RM.STAGES,
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("agent.main:app", host="127.0.0.1", port=agent_port())
