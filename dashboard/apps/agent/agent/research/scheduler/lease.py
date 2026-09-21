"""Execution leases — the cross-process claim on a job (spec §11, §13).

A worker must hold a live lease to run a job. The lease is persisted (never an
in-memory lock), carries an expiry, and is renewed by heartbeats. If a worker
dies, its heartbeat stops and the lease expires; the scheduler detects the stale
lease and makes the job recoverable (spec §42). Acquisition reads the durable
lease, so two processes cannot both claim one job.
"""

from __future__ import annotations

import logging

from . import model as S

log = logging.getLogger("agent.research.scheduler.lease")


class LeaseManager:
    """Issues and validates leases over the durable store. All methods are async
    and read/write SQLite through the shared store, so the authoritative record is
    never only in memory."""

    def __init__(self, store, *, clock, lease_ms: int, heartbeat_ms: int, stale_ms: int):
        self.store = store
        self.clock = clock
        self.lease_ms = lease_ms
        self.heartbeat_ms = heartbeat_ms
        # how long without a worker heartbeat before the worker is considered dead
        self.stale_ms = stale_ms

    async def acquire(self, job: S.ScheduledJob, worker_id: str) -> S.ExecutionLease | None:
        """Claim `job` for `worker_id`. Returns the lease, or None if another live
        lease already holds it. The claim is a single conditional upsert (see
        `store.acquire_lease`), so two workers racing cannot both win it."""
        now = self.clock.now_ms()
        lease = S.ExecutionLease(
            job_id=job.id,
            worker_id=worker_id,
            lease_id=S.make_lease_id(),
            acquired_at=now,
            expires_at=now + self.lease_ms,
            heartbeat_at=now,
        )
        won = await self.store.acquire_lease(lease, now=now)
        return lease if won else None

    async def heartbeat(self, lease: S.ExecutionLease) -> S.ExecutionLease:
        """Renew a lease and persist the new expiry."""
        now = self.clock.now_ms()
        lease.heartbeat_at = now
        lease.expires_at = now + self.lease_ms
        await self.store.put_lease(lease)
        return lease

    async def release(self, lease: S.ExecutionLease | None) -> None:
        if lease is None:
            return
        await self.store.delete_lease(lease.job_id)

    def is_valid(self, lease: S.ExecutionLease | None) -> bool:
        return lease is not None and not lease.is_expired(self.clock.now_ms())

    async def held_by(self, job_id: str) -> S.ExecutionLease | None:
        row = await self.store.get_lease(job_id)
        return S.ExecutionLease.from_row(row) if row else None

    async def expired_leases(self) -> list[S.ExecutionLease]:
        now = self.clock.now_ms()
        rows = await self.store.list_leases()
        out = []
        for r in rows:
            lease = S.ExecutionLease.from_row(r)
            if lease.is_expired(now):
                out.append(lease)
        return out
