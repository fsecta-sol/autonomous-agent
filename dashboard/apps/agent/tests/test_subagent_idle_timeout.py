"""Regression tests for the sub-agent *idle* timeout.

The defect these pin: a sub-agent was bounded by a wall-clock cap
(`asyncio.wait_for(ainvoke, timeout=900)`). A deep-research sub-agent that kept
working — streaming tokens, fetching pages that kept returning — was cut off at
exactly 900s no matter how much progress it was making, and its entire message
trail was discarded (`return (..., [])`), so the iteration was a black box.

The replacement resets the deadline on every streamed event (idle, not wall) and
harvests the last completed super-step on a real stall. These tests fail if
either behaviour regresses.

    cd apps/agent && .venv/bin/python -m unittest tests.test_subagent_idle_timeout -v
"""

from __future__ import annotations

import asyncio
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from langchain.agents.middleware import ModelRetryMiddleware  # noqa: E402
from langchain_core.language_models.chat_models import BaseChatModel  # noqa: E402
from langchain_core.messages import AIMessage, AIMessageChunk  # noqa: E402
from langchain_core.outputs import (  # noqa: E402
    ChatGeneration,
    ChatGenerationChunk,
    ChatResult,
)
from langchain_core.tools import tool  # noqa: E402

from agent import subagent as SA  # noqa: E402


@tool
def echo(x: str) -> str:
    """Echo the input back."""
    return f"echoed:{x}"


class _ProgressingSlowly(BaseChatModel):
    """Streams many small tokens with a short gap; total time far exceeds the
    idle limit, but it is never idle longer than it."""

    @property
    def _llm_type(self) -> str:
        return "fake-progressing"

    def bind_tools(self, tools, **kw):  # noqa: ANN001, ANN201
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kw):  # noqa: ANN001, ANN201
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content="done"))])

    async def _astream(self, messages, stop=None, run_manager=None, **kw):  # noqa: ANN001, ANN201
        for i in range(12):  # 12 * 0.2s = 2.4s total >> idle
            yield ChatGenerationChunk(message=AIMessageChunk(content=f"tok{i} "))
            await asyncio.sleep(0.2)
        yield ChatGenerationChunk(message=AIMessageChunk(content=""))


class _StallAfterOneRound(BaseChatModel):
    """One tool round (producing messages), then a permanent hang."""

    def __init__(self, **kw):  # noqa: ANN001
        super().__init__(**kw)
        self._n = 0

    @property
    def _llm_type(self) -> str:
        return "fake-stall"

    def bind_tools(self, tools, **kw):  # noqa: ANN001, ANN201
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kw):  # noqa: ANN001, ANN201
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content="x"))])

    async def _astream(self, messages, stop=None, run_manager=None, **kw):  # noqa: ANN001, ANN201
        self._n += 1
        if self._n == 1:
            yield ChatGenerationChunk(
                message=AIMessageChunk(
                    content="thinking",
                    tool_calls=[{"name": "echo", "args": {"x": "hi"}, "id": "c1", "type": "tool_call"}],
                )
            )
        else:
            yield ChatGenerationChunk(message=AIMessageChunk(content="partial-final"))
            await asyncio.sleep(100)  # hang: no further event
            yield ChatGenerationChunk(message=AIMessageChunk(content="never"))


def _fake_middleware(**_kw):
    return ModelRetryMiddleware(max_retries=0, on_failure="error")


class TestSubagentIdleTimeout(unittest.IsolatedAsyncioTestCase):
    async def test_active_subagent_is_not_cut_off_by_total_time(self):
        """A sub-agent that keeps streaming may run far past the idle limit in
        total — it must NOT be stopped, so long as it never stalls."""
        model = _ProgressingSlowly()
        with mock.patch.object(SA, "build_model", lambda req: model), \
             mock.patch.object(SA, "get_store", lambda: None), \
             mock.patch.object(SA, "upstream_retry_middleware", _fake_middleware):
            text, timed_out, messages = await SA.run_subagent_messages(
                object(), "researcher", "go", [echo], 0.5
            )
        self.assertFalse(timed_out, "a progressing sub-agent must not be cut off")
        self.assertTrue(text.startswith("tok0"), f"expected streamed text, got {text!r}")

    async def test_stalled_subagent_stops_and_harvests_partial(self):
        """A genuine stall (no event for the idle limit) stops the run, and the
        partial message trail is returned — never discarded."""
        model = _StallAfterOneRound()
        with mock.patch.object(SA, "build_model", lambda req: model), \
             mock.patch.object(SA, "get_store", lambda: None), \
             mock.patch.object(SA, "upstream_retry_middleware", _fake_middleware):
            text, timed_out, messages = await SA.run_subagent_messages(
                object(), "researcher", "go", [echo], 0.5
            )
        self.assertTrue(timed_out, "a stalled sub-agent must be stopped")
        self.assertGreaterEqual(
            len(messages), 2, "the partial trail must be harvested, not dropped"
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
