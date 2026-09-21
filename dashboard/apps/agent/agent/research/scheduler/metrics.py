"""Scheduler metrics (spec §49).

Counters the scheduler updates as it works, exposed as a snapshot for the debug
view and the API. In-memory and cheap; durable history lives in the job/attempt
tables. Counters are monotonic within a process — the durable tables are the
source of truth for "how many are queued now" etc.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class SchedulerMetrics:
    jobs_scheduled: int = 0
    jobs_completed: int = 0
    jobs_failed: int = 0
    jobs_retried: int = 0
    jobs_dead_lettered: int = 0
    jobs_cancelled: int = 0
    jobs_recovered: int = 0
    jobs_expired: int = 0

    workers_started: int = 0
    worker_failures: int = 0
    lease_expirations: int = 0

    guard_throttles: int = 0
    guard_pauses: int = 0
    circuit_breaks: int = 0
    coalesced_events: int = 0

    # latency accumulators (ms) — recomputed into averages on snapshot
    _execution_ms_total: int = 0
    _execution_count: int = 0
    _queue_latency_ms_total: int = 0
    _queue_latency_count: int = 0

    def incr(self, name: str, n: int = 1) -> None:
        if hasattr(self, name):
            setattr(self, name, getattr(self, name) + n)

    def observe_execution(self, ms: int) -> None:
        self._execution_ms_total += max(0, ms)
        self._execution_count += 1

    def observe_queue_latency(self, ms: int) -> None:
        self._queue_latency_ms_total += max(0, ms)
        self._queue_latency_count += 1

    def avg_execution_ms(self) -> float:
        return round(self._execution_ms_total / self._execution_count, 1) if self._execution_count else 0.0

    def avg_queue_latency_ms(self) -> float:
        return round(self._queue_latency_ms_total / self._queue_latency_count, 1) if self._queue_latency_count else 0.0

    def snapshot(self, *, queue_depth: dict[str, int] | None = None, workers: dict | None = None) -> dict:
        return {
            "jobsScheduled": self.jobs_scheduled,
            "jobsCompleted": self.jobs_completed,
            "jobsFailed": self.jobs_failed,
            "jobsRetried": self.jobs_retried,
            "jobsDeadLettered": self.jobs_dead_lettered,
            "jobsCancelled": self.jobs_cancelled,
            "jobsRecovered": self.jobs_recovered,
            "jobsExpired": self.jobs_expired,
            "workersStarted": self.workers_started,
            "workerFailures": self.worker_failures,
            "leaseExpirations": self.lease_expirations,
            "guardThrottles": self.guard_throttles,
            "guardPauses": self.guard_pauses,
            "circuitBreaks": self.circuit_breaks,
            "coalescedEvents": self.coalesced_events,
            "avgExecutionMs": self.avg_execution_ms(),
            "avgQueueLatencyMs": self.avg_queue_latency_ms(),
            "queueDepth": queue_depth or {},
            "workers": workers or {},
        }
