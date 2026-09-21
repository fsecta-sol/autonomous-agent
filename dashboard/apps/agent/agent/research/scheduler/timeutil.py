"""Time abstraction for the Scheduler.

Every "now" in the scheduler comes from a `Clock`, never from `time.time()` called
inline, so tests can drive hours or days of scheduling deterministically with a
`FakeClock` (spec §63: fake-clock time tests). Timestamps are canonical epoch
milliseconds (UTC); wall-clock rendering and cron matching go through
`zoneinfo`, so DST and named timezones behave correctly (spec §28).

Python 3.11 ships `zoneinfo` in the stdlib, so no third-party tz/cron dependency
is introduced (spec: reuse existing infrastructure).
"""

from __future__ import annotations

import time
from abc import ABC, abstractmethod
from datetime import datetime, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

UTC = timezone.utc


def now_ms() -> int:
    return int(time.time() * 1000)


class Clock(ABC):
    """Source of the current time. Injected everywhere the scheduler needs "now"."""

    @abstractmethod
    def now_ms(self) -> int:
        ...

    def now_dt(self, tz: str = "UTC") -> datetime:
        return ms_to_dt(self.now_ms(), tz)

    def sleep(self, seconds: float) -> None:
        """Advance wall time by `seconds` (real sleep, or a no-op on a fake clock)."""


class SystemClock(Clock):
    def now_ms(self) -> int:
        return int(time.time() * 1000)

    def sleep(self, seconds: float) -> None:
        time.sleep(seconds)


class FakeClock(Clock):
    """A manually-advanced clock for tests. `sleep` advances the fake time instead
    of blocking, so a test can simulate a long delay instantly."""

    def __init__(self, start_ms: int | None = None):
        self._ms = start_ms if start_ms is not None else now_ms()

    def now_ms(self) -> int:
        return self._ms

    def advance_ms(self, ms: int) -> None:
        self._ms += ms

    def advance_s(self, seconds: float) -> None:
        self._ms += int(seconds * 1000)

    def set_ms(self, ms: int) -> None:
        self._ms = ms

    def sleep(self, seconds: float) -> None:
        self.advance_s(seconds)


def ms_to_dt(ms: int, tz: str = "UTC") -> datetime:
    return datetime.fromtimestamp(ms / 1000, tz=zone(tz))


def dt_to_ms(dt: datetime) -> int:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return int(dt.timestamp() * 1000)


def zone(tz: str) -> ZoneInfo:
    try:
        return ZoneInfo(tz)
    except (ZoneInfoNotFoundError, ValueError, KeyError):
        # never fall back to the local machine timezone implicitly (spec §28):
        # an unknown zone is a configuration error, so surface it as UTC + warn
        import logging

        logging.getLogger("agent.research.scheduler.time").warning(
            "unknown timezone %r — using UTC", tz
        )
        return ZoneInfo("UTC")


def parse_iso(value: str) -> int | None:
    """Parse an ISO-8601 timestamp into canonical epoch ms (UTC). Naive input is
    interpreted as UTC, never as the local machine zone."""
    raw = (value or "").strip()
    if not raw:
        return None
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt_to_ms(dt)


def human(ms: int | None, tz: str = "UTC") -> str:
    if ms is None:
        return ""
    return ms_to_dt(ms, tz).strftime("%Y-%m-%dT%H:%M:%S%z")


def add_s(ms: int, seconds: float) -> int:
    return int(ms + seconds * 1000)
