"""Retry middleware shared by the agent's model calls.

`ModelRetryMiddleware` from langchain retries non-`ModelError` exceptions by
default, but it is only wired into the orchestrator graph — not the headless
sub-agents the research loop runs. A transient upstream failure (a 503 "model
temporarily unavailable", a 429, a dropped connection) therefore failed a whole
research iteration instead of being retried.

This module provides a middleware that retries exactly those transient upstream
errors, with exponential backoff and an optionally unbounded budget.
"""

from __future__ import annotations

import httpx
from langchain.agents.middleware import ModelRetryMiddleware, ToolRetryMiddleware

try:  # the client the configured OpenAI-compatible endpoint is reached through
    import openai
except Exception:  # pragma: no cover - openai is a hard dep, but stay import-safe
    openai = None


def is_transient_upstream_error(exc: Exception) -> bool:
    """Whether `exc` is a transient upstream/transport failure worth retrying:
    a 5xx or 408/409/425/429 status from the endpoint, or a connection/timeout
    error. Anything else (auth, bad request, a programming error) is permanent
    and propagates immediately rather than being retried."""
    if openai is not None:
        if isinstance(exc, openai.APIStatusError):
            return exc.status_code in (408, 409, 425, 429) or exc.status_code >= 500
        if isinstance(exc, openai.APIConnectionError):  # includes APITimeoutError
            return True
    if isinstance(exc, httpx.TransportError):
        return True
    return False


def upstream_retry_middleware(*, max_retries: int, max_delay: float = 300.0) -> ModelRetryMiddleware:
    """A model-retry middleware that retries ONLY transient upstream errors.

    `on_failure="error"` re-raises once the budget is exhausted, so a permanent
    failure is never masked as a successful model message. `max_delay` is raised
    above langchain's 60s default because this endpoint returns `retry in Ns`
    hints that can exceed a minute."""
    return ModelRetryMiddleware(
        max_retries=max_retries,
        retry_on=is_transient_upstream_error,
        on_failure="error",
        backoff_factor=2.0,
        initial_delay=1.0,
        max_delay=max_delay,
        jitter=True,
    )


def tool_upstream_retry_middleware(*, max_retries: int, max_delay: float = 60.0) -> ToolRetryMiddleware:
    """A tool-retry middleware that retries ONLY transient upstream errors.

    Same contract as `upstream_retry_middleware`, for tool calls: a tool whose
    failure is a transport/5xx error is retried, and `on_failure="error"`
    re-raises once the budget is spent so a deterministic tool error (bad args,
    a permanent failure) surfaces to the caller instead of being masked as a
    normal tool result."""
    return ToolRetryMiddleware(
        max_retries=max_retries,
        retry_on=is_transient_upstream_error,
        on_failure="error",
        backoff_factor=2.0,
        initial_delay=1.0,
        max_delay=max_delay,
        jitter=True,
    )
