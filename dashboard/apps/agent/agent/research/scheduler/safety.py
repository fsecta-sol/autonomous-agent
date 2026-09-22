"""Safety guards: runaway protection, event-storm coalescing, circuit breaking
(spec §60-62).

Autonomous scheduling can fail open: a research loop that keeps emitting "run
now" produces an execution storm; a burst of the same event schedules thousands
of jobs. These guards sit in front of job creation:

  * `RunawayGuard`   — per-schedule rate + burst limits, with THROTTLE / PAUSE /
                       CIRCUIT_BREAK actions when a schedule fires too often.
  * `EventCoalescer` — debounces and coalesces repeated events so a burst becomes
                       one scheduling decision (spec §62).
  * `CircuitBreaker` — trips after repeated failures for a key, so a persistently
                       broken schedule stops hammering instead of storming.
"""

from __future__ import annotations

from dataclasses import dataclass

from . import model as S

# actions a guard can recommend
GUARD_OK = "OK"
GUARD_THROTTLE = "THROTTLE"
GUARD_PAUSE = "PAUSE"
GUARD_CIRCUIT_BREAK = "CIRCUIT_BREAK"


@dataclass
class GuardDecision:
    action: str = GUARD_OK
    reason: str = ""

    def allowed(self) -> bool:
        return self.action == GUARD_OK


class RunawayGuard:
    """Detects and limits a schedule that fires too fast (spec §61).

    `min_interval_s` is the shortest gap allowed between two fires of one
    schedule; `max_per_hour` caps fires per rolling hour. A schedule with a
    zero-delay immediate trigger that re-schedules itself will hit the interval
    floor and be throttled, then paused after repeated violations.
    """

    def __init__(self, *, min_interval_s: float = 5.0, max_per_hour: int = 120, pause_after: int = 5):
        self.min_interval_s = min_interval_s
        self.max_per_hour = max_per_hour
        self.pause_after = pause_after
        self._fires: dict[str, list[int]] = {}
        self._violations: dict[str, int] = {}

    def check(self, schedule: S.Schedule, now_ms: int, *, fire_due: bool = True) -> GuardDecision:
        """Decide whether this schedule may fire now.

        `fire_due` says whether a fire is actually pending this evaluation. The
        interval/rate limits only describe *fires*, so they must be judged only
        when one is pending — otherwise every idle tick inside the interval floor
        would count as a violation and a healthy schedule would be PAUSEd by ticks
        alone (the `_fire_triggers` loop calls this for every active schedule on
        every tick)."""
        fires = self._fires.setdefault(schedule.id, [])
        # drop fires older than an hour
        cutoff = now_ms - 3_600_000
        fires[:] = [t for t in fires if t >= cutoff]

        if fire_due and schedule.last_run_at is not None:
            gap_s = (now_ms - schedule.last_run_at) / 1000.0
            if gap_s < self.min_interval_s:
                self._violations[schedule.id] = self._violations.get(schedule.id, 0) + 1
                if self._violations[schedule.id] >= self.pause_after:
                    return GuardDecision(GUARD_PAUSE, f"fired {gap_s:.1f}s apart {self._violations[schedule.id]}x — schedule paused")
                return GuardDecision(GUARD_THROTTLE, f"fired {gap_s:.1f}s ago; floor is {self.min_interval_s}s")

        # the hourly cap is a property of *fires* too, but it reads recorded fires
        # rather than the pending one, so it stays meaningful whenever it is full.
        cap = schedule.max_runs_per_hour or self.max_per_hour
        if fire_due and cap and len(fires) >= cap:
            return GuardDecision(GUARD_CIRCUIT_BREAK, f"{len(fires)} fires in the last hour (cap {cap})")

        return GuardDecision(GUARD_OK)

    def record_fire(self, schedule_id: str, now_ms: int) -> None:
        self._fires.setdefault(schedule_id, []).append(now_ms)
        self._violations[schedule_id] = 0  # a legitimate fire clears the streak

    def reset(self, schedule_id: str) -> None:
        self._fires.pop(schedule_id, None)
        self._violations.pop(schedule_id, None)


class EventCoalescer:
    """Coalesces a burst of the same event into one scheduling decision (spec §62).

    An event arriving within `window_ms` of a previous one for the same event
    name is folded into it: `ready()` returns the events whose window has closed,
    so the scheduler creates at most one job per (event, window)."""

    def __init__(self, window_ms: int = 1000):
        self.window_ms = window_ms
        self._pending: dict[str, int] = {}   # event name → first-seen ms

    def observe(self, event: str, now_ms: int) -> bool:
        """Record an event. Returns True if it opened a new window (i.e. it is the
        first of a fresh burst), False if coalesced into an open one."""
        first = self._pending.get(event)
        if first is None or (now_ms - first) >= self.window_ms:
            self._pending[event] = now_ms
            return True
        return False

    def ready(self, now_ms: int) -> list[str]:
        """Event names whose window has closed and are ready to schedule once."""
        out = [e for e, first in self._pending.items() if (now_ms - first) >= self.window_ms]
        for e in out:
            self._pending.pop(e, None)
        return out

    def pending(self) -> list[str]:
        return list(self._pending.keys())


class CircuitBreaker:
    """Trips after `threshold` consecutive failures for a key (spec §60).

    While open, scheduling for that key is refused (no job created) until
    `cooldown_ms` elapses, after which it goes half-open: one job is allowed as a
    probe; success closes it, failure re-opens."""

    def __init__(self, *, threshold: int = 5, cooldown_ms: int = 300_000):
        self.threshold = threshold
        self.cooldown_ms = cooldown_ms
        self._failures: dict[str, int] = {}
        self._opened_at: dict[str, int] = {}
        self._half_open: set[str] = set()

    def is_open(self, key: str, now_ms: int) -> bool:
        opened = self._opened_at.get(key)
        if opened is None:
            return False
        if (now_ms - opened) >= self.cooldown_ms:
            # cooldown elapsed → allow a single probe
            self._half_open.add(key)
            return False
        return True

    def allow(self, key: str, now_ms: int) -> GuardDecision:
        if self.is_open(key, now_ms):
            return GuardDecision(GUARD_CIRCUIT_BREAK, f"circuit open after {self._failures.get(key, 0)} failures")
        return GuardDecision(GUARD_OK)

    def record_success(self, key: str) -> None:
        self._failures.pop(key, None)
        self._opened_at.pop(key, None)
        self._half_open.discard(key)

    def record_failure(self, key: str, now_ms: int) -> None:
        n = self._failures.get(key, 0) + 1
        self._failures[key] = n
        if n >= self.threshold:
            self._opened_at[key] = now_ms

    def state(self, key: str) -> dict:
        return {
            "failures": self._failures.get(key, 0),
            "open": key in self._opened_at,
            "halfOpen": key in self._half_open,
        }
