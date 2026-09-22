"""Retry policies, backoff strategies, and error classification (spec §15, §16).

`backoff_delay_ms(policy, attempt)` computes the wait before attempt N using the
configured strategy, with optional jitter to avoid a thundering herd when many
jobs fail at once. `classify_error(exc)` maps an exception into RETRYABLE /
NON_RETRYABLE / UNKNOWN so a permanent failure (bad config, permission) is not
retried into a storm. Both are registry-backed so a deployment can plug its own.
"""

from __future__ import annotations

import random
from abc import ABC, abstractmethod
from typing import Any

from ..registry import Registry
from . import model as S

RETRY_POLICY_REGISTRY: Registry[BackoffStrategy] = Registry("retry_strategy")


class BackoffStrategy(ABC):
    name: str = ""

    @abstractmethod
    def delay_ms(self, policy: S.RetryPolicy, attempt: int) -> int:
        """Delay before the given attempt (1-based: attempt 1 is the first retry)."""


class FixedBackoff(BackoffStrategy):
    name = S.RETRY_FIXED

    def delay_ms(self, policy: S.RetryPolicy, attempt: int) -> int:
        return policy.base_delay_ms


class LinearBackoff(BackoffStrategy):
    name = S.RETRY_LINEAR

    def delay_ms(self, policy: S.RetryPolicy, attempt: int) -> int:
        return policy.base_delay_ms * attempt


class ExponentialBackoff(BackoffStrategy):
    name = S.RETRY_EXPONENTIAL

    def delay_ms(self, policy: S.RetryPolicy, attempt: int) -> int:
        return _capped(policy.base_delay_ms * (2 ** (attempt - 1)), policy)


class ExponentialJitterBackoff(BackoffStrategy):
    name = S.RETRY_EXPONENTIAL_JITTER

    def delay_ms(self, policy: S.RetryPolicy, attempt: int) -> int:
        raw = policy.base_delay_ms * (2 ** (attempt - 1))
        span = raw * max(0.0, policy.jitter)
        jittered = raw + random.uniform(-span, span)
        return _capped(jittered, policy)


def _capped(delay: float, policy: S.RetryPolicy) -> int:
    return int(max(0.0, min(delay, policy.max_delay_ms)))


RETRY_POLICY_REGISTRY.register(S.RETRY_FIXED, FixedBackoff())
RETRY_POLICY_REGISTRY.register(S.RETRY_LINEAR, LinearBackoff())
RETRY_POLICY_REGISTRY.register(S.RETRY_EXPONENTIAL, ExponentialBackoff())
RETRY_POLICY_REGISTRY.register(S.RETRY_EXPONENTIAL_JITTER, ExponentialJitterBackoff())


def backoff_delay_ms(policy: S.RetryPolicy, attempt: int) -> int:
    """Delay before retry `attempt` (1-based), using the policy's strategy."""
    strategy = RETRY_POLICY_REGISTRY.get(policy.strategy) if RETRY_POLICY_REGISTRY.has(policy.strategy) else None
    if strategy is None:
        strategy = RETRY_POLICY_REGISTRY.get(S.RETRY_EXPONENTIAL_JITTER)
    return max(0, strategy.delay_ms(policy, max(1, attempt)))


def should_retry(policy: S.RetryPolicy, attempt: int, error_class: str) -> bool:
    """Whether another attempt is allowed. A NON_RETRYABLE error never retries,
    regardless of the attempt count."""
    if error_class == S.NON_RETRYABLE:
        return False
    return attempt < policy.max_attempts


# ── error classification (spec §16) ──────────────────────────────────────────

# exception type names that are permanent — retrying them wastes budget and can
# storm the provider
_NON_RETRYABLE_NAMES = {
    "ValueError", "TypeError", "KeyError", "AttributeError", "NotImplementedError",
    "PermissionError", "FileNotFoundError", "IsADirectoryError", "ZeroDivisionError",
    "ValidationError", "CancelledError", "ConfigurationError",
}
# exception type names that are transient
_RETRYABLE_NAMES = {
    "TimeoutError", "asyncio.TimeoutError", "ConnectionError", "ConnectionResetError",
    "BrokenPipeError", "ConnectionRefusedError", "ConnectionAbortedError",
    "OperationalError", "DatabaseError", "InterfaceError", "HTTPError", "ReadTimeout",
    "ConnectTimeout", "RemoteProtocolError", "RateLimitError", "ServiceUnavailable",
}
# message fragments that indicate a permanent condition even off a generic type
_NON_RETRYABLE_HINTS = (
    "invalid configuration", "permission denied", "not permitted", "unsupported",
    "malformed", "authentication failed", "unauthorized", "forbidden", "cancelled",
    "user cancel", "does not exist", "no such",
)
_RETRYABLE_HINTS = (
    "timeout", "timed out", "rate limit", "429", "503", "502", "504", "temporarily",
    "temporary", "connection reset", "connection refused", "unavailable", "try again",
    "econnreset", "econnrefused", "network",
)


def classify_error(exc: BaseException | str | None) -> tuple[str, str, str]:
    """Classify an error into (retry_class, kind, message)."""
    if exc is None:
        return S.RETRY_UNKNOWN, "", ""
    if isinstance(exc, str):
        msg = exc
        kind = ""
    else:
        msg = str(exc) or exc.__class__.__name__
        kind = exc.__class__.__name__
    low = msg.lower()

    if kind in _NON_RETRYABLE_NAMES or any(h in low for h in _NON_RETRYABLE_HINTS):
        return S.NON_RETRYABLE, kind, msg
    if kind in _RETRYABLE_NAMES or any(h in low for h in _RETRYABLE_HINTS):
        return S.RETRYABLE, kind, msg
    return S.RETRY_UNKNOWN, kind, msg


def classify_result(error_kind: str, error_message: str = "") -> tuple[str, str, str]:
    """Classify from already-structured fields (e.g. a worker's failure_kind),
    mapping the research failure taxonomy onto retry classes."""
    from .. import models as M

    kind = error_kind or ""
    message = error_message or ""
    # research failure kinds that are transient
    if kind in (M.FAIL_TOOL, M.FAIL_SOURCE_UNAVAILABLE, M.FAIL_TIMEOUT):
        return S.RETRYABLE, kind, message or kind
    # a rejected hypothesis / insufficient evidence / budget / blocked are not
    # retryable as-is — retrying them unchanged would just repeat the outcome
    if kind in (M.FAIL_INSUFFICIENT_EVIDENCE, M.FAIL_HYPOTHESIS_REJECTED, M.FAIL_BUDGET, M.FAIL_BLOCKED):
        return S.NON_RETRYABLE, kind, message or kind
    return classify_error(message or kind)


def serialize_error(exc: BaseException) -> dict[str, Any]:
    """A compact, JSON-safe error record for the job's `last_error`."""
    cls, kind, msg = classify_error(exc)
    return {"class": cls, "kind": kind or exc.__class__.__name__, "message": msg[:500], "retryable": cls != S.NON_RETRYABLE}
