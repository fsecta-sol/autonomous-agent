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

from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .checkpointer import close_checkpointer, get_checkpointer, init_checkpointer
from .config import agent_port
from .control import list_history, rewind_to
from .graph import stream_run
from .models import RunRequest
from .spawn_log import list_spawns
from .spawns import extract_spawns
from .sse import frame, keepalive
from .store import close_store, init_store

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

log = logging.getLogger("agent.main")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """Open the checkpoint store (thread state) and the memory store (cross-
    session facts) for the life of the process."""
    await init_checkpointer()
    await init_store()
    try:
        yield
    finally:
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


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("agent.main:app", host="127.0.0.1", port=agent_port())
