"""A small, timezone-aware 5-field cron parser.

Fields: `minute hour day-of-month month day-of-week`. Supports `*`, lists
(`a,b,c`), ranges (`a-b`), steps (`*/n`, `a-b/n`, `a/n`), and the common 3-letter
names for months and weekdays. Day-of-week is 0-6 with Sunday = 0 (and 7 also
accepted as Sunday).

No third-party cron dependency is installed, so this is the minimal correct
implementation (spec §6: "don't hardcode a cron parser yourself if an existing
dependency can be used" — none can here). Matching runs on wall-clock dates in
the schedule's timezone, so DST boundaries behave correctly (spec §28): days are
iterated as tz-independent `date` objects and each candidate is rebuilt from
components, so a shifted hour never causes drift.
"""

from __future__ import annotations

import re
from datetime import date, datetime, timedelta

from . import timeutil as T

_MONTHS = {"jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
           "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12}
_DOWS = {"sun": 0, "mon": 1, "tue": 2, "wed": 3, "thu": 4, "fri": 5, "sat": 6}

# search bound for a next occurrence (a leap-year Feb 29 + weekday combo is the
# worst realistic case); beyond this the expression is treated as never-firing
_MAX_DAYS = 366 * 8


class CronError(ValueError):
    pass


def _parse_field(spec: str, lo: int, hi: int, names: dict[str, int] | None = None) -> set[int]:
    """Expand one cron field into the set of values it matches."""
    spec = spec.strip().lower()
    if not spec:
        raise CronError("empty cron field")
    out: set[int] = set()
    for part in spec.split(","):
        part = part.strip()
        step = 1
        if "/" in part:
            part, _, step_s = part.partition("/")
            try:
                step = int(step_s)
            except ValueError as exc:
                raise CronError(f"bad step in {spec!r}") from exc
            if step <= 0:
                raise CronError(f"non-positive step in {spec!r}")
        if part in ("*", ""):
            start, end = lo, hi
        elif "-" in part and not part.startswith("-"):
            a, _, b = part.partition("-")
            start, end = _val(a, names), _val(b, names)
        else:
            start = end = _val(part, names)
        if start > end:
            raise CronError(f"reversed range in {spec!r}")
        rng = range(start, end + 1, step)
        for v in rng:
            if not (lo <= v <= hi):
                raise CronError(f"value {v} out of range [{lo},{hi}] in {spec!r}")
            out.add(v)
    if not out:
        raise CronError(f"no values matched in {spec!r}")
    return out


def _val(token: str, names: dict[str, int] | None) -> int:
    token = token.strip().lower()
    if names and token in names:
        return names[token]
    try:
        return int(token)
    except ValueError as exc:
        raise CronError(f"bad value {token!r}") from exc


class CronExpression:
    """A parsed 5-field cron expression, evaluated in a named timezone."""

    __slots__ = ("dom_restricted", "doms", "dow_restricted", "dows", "hours", "minutes", "months", "source")

    def __init__(self, expression: str):
        fields = re.split(r"\s+", (expression or "").strip())
        if len(fields) != 5:
            raise CronError(f"expected 5 fields, got {len(fields)}: {expression!r}")
        self.source = expression.strip()
        minute_s, hour_s, dom_s, month_s, dow_s = fields
        self.minutes = _parse_field(minute_s, 0, 59)
        self.hours = _parse_field(hour_s, 0, 23)
        self.doms = _parse_field(dom_s, 1, 31)
        self.months = _parse_field(month_s, 1, 12, _MONTHS)
        dow_raw = _parse_field(dow_s, 0, 7, _DOWS)
        # normalize 7 → 0 (both mean Sunday)
        self.dows = {0 if d == 7 else d for d in dow_raw}
        self.dom_restricted = dom_s.strip() != "*"
        self.dow_restricted = dow_s.strip() != "*"

    def _day_matches(self, d: date) -> bool:
        dom_ok = d.day in self.doms
        # cron weekday: Monday=0 .. Sunday=6 ; our set uses Sunday=0 .. Saturday=6
        dow = (d.weekday() + 1) % 7
        dow_ok = dow in self.dows
        if self.dom_restricted and self.dow_restricted:
            return dom_ok or dow_ok  # Vixie-cron OR semantics
        if self.dom_restricted:
            return dom_ok
        if self.dow_restricted:
            return dow_ok
        return True

    def next_after(self, after_ms: int, tz: str = "UTC") -> int | None:
        """The first matching instant strictly after `after_ms`, in `tz`."""
        zone = T.zone(tz)
        start = datetime.fromtimestamp(after_ms / 1000, tz=zone)
        start_date = start.date()
        times = sorted((h, m) for h in self.hours for m in self.minutes)
        for i in range(_MAX_DAYS):
            d = start_date + timedelta(days=i)
            if d.month not in self.months:
                continue
            if not self._day_matches(d):
                continue
            for h, m in times:
                cand = datetime(d.year, d.month, d.day, h, m, tzinfo=zone)
                cand_ms = T.dt_to_ms(cand)
                if cand_ms > after_ms:
                    return cand_ms
        return None

    def matches(self, at_ms: int, tz: str = "UTC") -> bool:
        """Whether the instant lands exactly on a cron minute."""
        dt = T.ms_to_dt(at_ms, tz)
        if dt.second != 0 or dt.microsecond != 0:
            return False
        return (
            dt.minute in self.minutes
            and dt.hour in self.hours
            and dt.month in self.months
            and self._day_matches(dt.date())
        )


def parse(expression: str) -> CronExpression:
    return CronExpression(expression)


def is_valid(expression: str) -> bool:
    try:
        CronExpression(expression)
        return True
    except CronError:
        return False


def next_occurrence(expression: str, after_ms: int, tz: str = "UTC") -> int | None:
    """Convenience: next matching instant for `expression` after `after_ms`."""
    return CronExpression(expression).next_after(after_ms, tz)
