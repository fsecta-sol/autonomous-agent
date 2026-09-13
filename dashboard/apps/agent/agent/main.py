"""FastAPI entrypoint for the agent service.

`POST /run` takes the config payload the backend resolved and streams back our
SSE envelope protocol (identical to the old Node chat-engine). `GET /health`
is a readiness probe.
"""

import logging

from fastapi import FastAPI
from fastapi.responses import StreamingResponse

from .config import agent_port
from .graph import stream_run
from .models import RunRequest
from .sse import frame

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

app = FastAPI(title="dashboard-agent", version="0.1.0")


@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}


@app.post("/run")
async def run(req: RunRequest) -> StreamingResponse:
    async def body():
        try:
            async for envelope in stream_run(req):
                yield frame(envelope)
        except Exception as err:  # noqa: BLE001 — never leak a raw traceback as the body
            yield frame({"type": "error", "message": str(err)})
            yield frame({"type": "done"})

    return StreamingResponse(
        body(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no"},
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("agent.main:app", host="127.0.0.1", port=agent_port())
