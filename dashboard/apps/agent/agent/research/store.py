"""Durable state for the Research Loop — the State Manager + Research Memory.

One aiosqlite database (like the spawn log) holding every persistent unit the
loop needs to survive a restart mid-iteration: runs, iterations, candidates,
plans, results, the anti-redundancy attempt ledger, and the event log. Opening
it is idempotent; the schema is inline DDL so there is no migration step.

Two roles live here, deliberately separate from the Knowledge Manager:

  * State Manager   — "where am I?"  (the run + its current stage/iteration)
  * Research Memory — "what have I already tried?"  (candidates, plans, results,
                      attempts — so a failed approach is not blindly repeated)

Nothing here decides anything; the loop's modules do. This file only persists.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from pathlib import Path
from typing import Any

import aiosqlite

from ..config import research_db_path, research_events_path
from . import models as M
from .events import ResearchEvent

log = logging.getLogger("agent.research.store")


def _table_of(sql: str) -> str:
    """The table a `SELECT … FROM <table> …` reads, for `_decode`'s column rules.

    Matches the first `FROM` that is followed by a plain identifier, so a
    subquery (`FROM (SELECT …)`), a starred or bracketed source does not yield a
    bogus table name the way `sql.split("FROM")[1].split()[0]` did."""
    m = re.search(r"\bFROM\s+([A-Za-z_][A-Za-z0-9_]*)", sql, re.IGNORECASE)
    return m.group(1) if m else ""


def _append_line(path: Path, line: str) -> None:
    """Append one JSONL line. Runs off the event loop (see `asyncio.to_thread`)."""
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(line + "\n")

_DDL = """
CREATE TABLE IF NOT EXISTS research_runs (
  id                   TEXT PRIMARY KEY,
  objective            TEXT NOT NULL,
  status               TEXT NOT NULL,
  stage                TEXT NOT NULL,
  iteration            INTEGER NOT NULL,
  started_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  completed_at         INTEGER,
  budget               TEXT NOT NULL,
  progress             TEXT NOT NULL,
  termination_reason   TEXT NOT NULL DEFAULT '',
  parent_run_id        TEXT,
  agent_id             TEXT NOT NULL DEFAULT '',
  metadata             TEXT NOT NULL DEFAULT '{}',
  current_iteration_id TEXT,
  current_candidate_id TEXT
);

CREATE TABLE IF NOT EXISTS research_iterations (
  id               TEXT PRIMARY KEY,
  run_id           TEXT NOT NULL,
  idx              INTEGER NOT NULL,
  hypothesis       TEXT NOT NULL DEFAULT '',
  branch           TEXT NOT NULL DEFAULT 'main',
  candidate_id     TEXT,
  plan_id          TEXT,
  result_id        TEXT,
  strategy         TEXT NOT NULL DEFAULT '',
  stage            TEXT NOT NULL DEFAULT 'IDLE',
  disposition      TEXT NOT NULL DEFAULT '',
  knowledge_updates TEXT NOT NULL DEFAULT '[]',
  evaluation       TEXT NOT NULL DEFAULT '{}',
  next_action      TEXT NOT NULL DEFAULT '',
  next_reason      TEXT NOT NULL DEFAULT '',
  started_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  finished_at      INTEGER
);
CREATE INDEX IF NOT EXISTS research_iter_run_idx ON research_iterations(run_id, idx);

CREATE TABLE IF NOT EXISTS research_candidates (
  id                        TEXT PRIMARY KEY,
  run_id                    TEXT NOT NULL,
  question                  TEXT NOT NULL,
  reason                    TEXT NOT NULL DEFAULT '',
  objective                 TEXT NOT NULL DEFAULT '',
  expected_information_gain TEXT NOT NULL DEFAULT 'medium',
  priority_hint             TEXT NOT NULL DEFAULT 'medium',
  dependencies              TEXT NOT NULL DEFAULT '[]',
  estimated_cost            TEXT NOT NULL DEFAULT 'medium',
  risk                      TEXT NOT NULL DEFAULT 'low',
  related_knowledge         TEXT NOT NULL DEFAULT '[]',
  related_unknowns          TEXT NOT NULL DEFAULT '[]',
  related_conflicts         TEXT NOT NULL DEFAULT '[]',
  branch                    TEXT NOT NULL DEFAULT 'main',
  source_gap_kind           TEXT NOT NULL DEFAULT '',
  priority                  REAL NOT NULL DEFAULT 0,
  rank_inputs               TEXT NOT NULL DEFAULT '{}',
  status                    TEXT NOT NULL DEFAULT 'open',
  created_at                INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS research_cand_run_idx ON research_candidates(run_id, created_at);

CREATE TABLE IF NOT EXISTS research_plans (
  id                TEXT PRIMARY KEY,
  run_id            TEXT NOT NULL,
  candidate_id      TEXT NOT NULL,
  question          TEXT NOT NULL,
  strategy          TEXT NOT NULL,
  steps             TEXT NOT NULL DEFAULT '[]',
  expected_evidence TEXT NOT NULL DEFAULT '[]',
  success_conditions TEXT NOT NULL DEFAULT '[]',
  failure_conditions TEXT NOT NULL DEFAULT '[]',
  constraints       TEXT NOT NULL DEFAULT '[]',
  created_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS research_results (
  id                 TEXT PRIMARY KEY,
  run_id             TEXT NOT NULL,
  iteration_id       TEXT NOT NULL,
  candidate_id       TEXT NOT NULL,
  strategy           TEXT NOT NULL,
  question           TEXT NOT NULL DEFAULT '',
  observations       TEXT NOT NULL DEFAULT '[]',
  evidence           TEXT NOT NULL DEFAULT '[]',
  sources            TEXT NOT NULL DEFAULT '[]',
  experiments        TEXT NOT NULL DEFAULT '[]',
  artifacts          TEXT NOT NULL DEFAULT '[]',
  conclusions        TEXT NOT NULL DEFAULT '[]',
  uncertainties      TEXT NOT NULL DEFAULT '[]',
  hypothesis_survived INTEGER,
  failure_kind       TEXT NOT NULL DEFAULT '',
  failure_reason     TEXT NOT NULL DEFAULT '',
  cost               TEXT NOT NULL DEFAULT '{}',
  trace              TEXT NOT NULL DEFAULT '[]',
  created_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS research_result_iter_idx ON research_results(iteration_id);

CREATE TABLE IF NOT EXISTS research_attempts (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL,
  candidate_id  TEXT NOT NULL,
  question_norm TEXT NOT NULL,
  strategy      TEXT NOT NULL,
  outcome       TEXT NOT NULL,
  failure_kind  TEXT NOT NULL DEFAULT '',
  info_gain     REAL NOT NULL DEFAULT 0,
  ts            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS research_attempt_run_idx ON research_attempts(run_id, question_norm);

CREATE TABLE IF NOT EXISTS research_events (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL,
  type            TEXT NOT NULL,
  iteration_index INTEGER,
  data            TEXT NOT NULL DEFAULT '{}',
  ts              INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS research_event_run_idx ON research_events(run_id, ts);

CREATE TABLE IF NOT EXISTS research_evaluations (
  id                    TEXT PRIMARY KEY,
  research_run_id       TEXT NOT NULL,
  iteration_id          TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'NO_PROGRESS',
  result_quality        REAL NOT NULL DEFAULT 0,
  evidence_quality      REAL NOT NULL DEFAULT 0,
  source_quality        REAL NOT NULL DEFAULT 0,
  relevance             REAL NOT NULL DEFAULT 0,
  completeness          REAL NOT NULL DEFAULT 0,
  novelty               REAL NOT NULL DEFAULT 0,
  knowledge_gain        REAL NOT NULL DEFAULT 0,
  uncertainty_reduction REAL NOT NULL DEFAULT 0,
  objective_progress    REAL NOT NULL DEFAULT 0,
  confidence            REAL NOT NULL DEFAULT 0,
  answered_questions    TEXT NOT NULL DEFAULT '[]',
  unanswered_questions  TEXT NOT NULL DEFAULT '[]',
  new_knowledge_ids     TEXT NOT NULL DEFAULT '[]',
  updated_knowledge_ids TEXT NOT NULL DEFAULT '[]',
  contradictions        TEXT NOT NULL DEFAULT '[]',
  discoveries           TEXT NOT NULL DEFAULT '[]',
  unresolved_unknowns   TEXT NOT NULL DEFAULT '[]',
  redundant_with        TEXT NOT NULL DEFAULT '[]',
  failures              TEXT NOT NULL DEFAULT '[]',
  evidence_assessments  TEXT NOT NULL DEFAULT '[]',
  signals               TEXT NOT NULL DEFAULT '[]',
  recommendation        TEXT NOT NULL DEFAULT '{}',
  reasoning             TEXT NOT NULL DEFAULT '{}',
  strategy              TEXT NOT NULL DEFAULT '',
  scored_by             TEXT NOT NULL DEFAULT '[]',
  llm_assisted          INTEGER NOT NULL DEFAULT 0,
  created_at            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS research_eval_run_idx ON research_evaluations(research_run_id, created_at);
CREATE INDEX IF NOT EXISTS research_eval_iter_idx ON research_evaluations(iteration_id);

CREATE TABLE IF NOT EXISTS sched_schedules (
  id              TEXT PRIMARY KEY,
  research_run_id TEXT NOT NULL,
  type            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'ACTIVE',
  cron            TEXT NOT NULL DEFAULT '',
  interval_s      INTEGER NOT NULL DEFAULT 0,
  at              INTEGER,
  delay_s         INTEGER NOT NULL DEFAULT 0,
  event           TEXT NOT NULL DEFAULT '',
  depends_on      TEXT NOT NULL DEFAULT '[]',
  dep_condition   TEXT NOT NULL DEFAULT 'COMPLETED',
  timezone        TEXT NOT NULL DEFAULT 'UTC',
  priority        TEXT NOT NULL DEFAULT 'NORMAL',
  retry           TEXT NOT NULL DEFAULT '{}',
  concurrency     TEXT NOT NULL DEFAULT '{}',
  resources       TEXT NOT NULL DEFAULT '{}',
  deadline        INTEGER,
  next_run_at     INTEGER,
  last_run_at     INTEGER,
  run_count       INTEGER NOT NULL DEFAULT 0,
  max_runs        INTEGER,
  max_runs_per_hour INTEGER NOT NULL DEFAULT 0,
  created_by      TEXT NOT NULL DEFAULT 'SYSTEM',
  metadata        TEXT NOT NULL DEFAULT '{}',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sched_schedule_status_idx ON sched_schedules(status, next_run_at);

CREATE TABLE IF NOT EXISTS sched_jobs (
  id                 TEXT PRIMARY KEY,
  schedule_id        TEXT NOT NULL,
  research_run_id    TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'SCHEDULED',
  priority           TEXT NOT NULL DEFAULT 'NORMAL',
  scheduled_at       INTEGER NOT NULL,
  ready_at           INTEGER,
  started_at         INTEGER,
  completed_at       INTEGER,
  attempt            INTEGER NOT NULL DEFAULT 0,
  max_attempts       INTEGER NOT NULL DEFAULT 3,
  worker_id          TEXT NOT NULL DEFAULT '',
  lease_id           TEXT NOT NULL DEFAULT '',
  idempotency_key    TEXT NOT NULL DEFAULT '',
  dependency_ids     TEXT NOT NULL DEFAULT '[]',
  dep_condition      TEXT NOT NULL DEFAULT 'COMPLETED',
  resources          TEXT NOT NULL DEFAULT '{}',
  last_error         TEXT NOT NULL DEFAULT '{}',
  decision           TEXT NOT NULL DEFAULT '',
  decision_reasons   TEXT NOT NULL DEFAULT '[]',
  wait_reason        TEXT NOT NULL DEFAULT '',
  checkpoint_iteration INTEGER,
  replay_of          TEXT NOT NULL DEFAULT '',
  created_by         TEXT NOT NULL DEFAULT 'SYSTEM',
  metadata           TEXT NOT NULL DEFAULT '{}',
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sched_job_status_idx ON sched_jobs(status, scheduled_at);
CREATE INDEX IF NOT EXISTS sched_job_schedule_idx ON sched_jobs(schedule_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS sched_job_idem_idx ON sched_jobs(idempotency_key) WHERE idempotency_key <> '';

CREATE TABLE IF NOT EXISTS sched_attempts (
  id             TEXT PRIMARY KEY,
  job_id         TEXT NOT NULL,
  worker_id      TEXT NOT NULL DEFAULT '',
  attempt        INTEGER NOT NULL DEFAULT 0,
  started_at     INTEGER NOT NULL,
  finished_at    INTEGER,
  outcome        TEXT NOT NULL DEFAULT '',
  error_class    TEXT NOT NULL DEFAULT '',
  error_kind     TEXT NOT NULL DEFAULT '',
  error_message  TEXT NOT NULL DEFAULT '',
  iteration_from INTEGER,
  iteration_to   INTEGER,
  detail         TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS sched_attempt_job_idx ON sched_attempts(job_id, started_at);

CREATE TABLE IF NOT EXISTS sched_leases (
  job_id        TEXT PRIMARY KEY,
  worker_id     TEXT NOT NULL,
  lease_id      TEXT NOT NULL,
  acquired_at   INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  heartbeat_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sched_workers (
  id                TEXT PRIMARY KEY,
  capabilities      TEXT NOT NULL DEFAULT '[]',
  max_concurrency   INTEGER NOT NULL DEFAULT 1,
  status            TEXT NOT NULL DEFAULT 'STARTING',
  started_at        INTEGER NOT NULL,
  last_heartbeat_at INTEGER NOT NULL,
  stopped_at        INTEGER,
  active_jobs       INTEGER NOT NULL DEFAULT 0,
  completed_jobs    INTEGER NOT NULL DEFAULT 0,
  failed_jobs       INTEGER NOT NULL DEFAULT 0,
  metadata          TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS sched_events (
  id            TEXT PRIMARY KEY,
  job_id        TEXT NOT NULL DEFAULT '',
  schedule_id   TEXT NOT NULL DEFAULT '',
  type          TEXT NOT NULL,
  data          TEXT NOT NULL DEFAULT '{}',
  ts            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sched_event_ts_idx ON sched_events(ts);
"""

# Columns stored as JSON text per table (serialise on write, parse on read).
_JSON_COLS = {
    "research_runs": {"objective", "budget", "progress", "metadata"},
    "research_iterations": {"knowledge_updates", "evaluation"},
    "research_candidates": {
        "related_knowledge", "related_unknowns", "related_conflicts", "rank_inputs",
    },
    "research_plans": {"steps", "expected_evidence", "success_conditions", "failure_conditions", "constraints"},
    "research_results": {
        "observations", "evidence", "sources", "experiments", "artifacts", "conclusions", "uncertainties", "cost", "trace",
    },
    "research_events": {"data"},
    "research_evaluations": {
        "answered_questions", "unanswered_questions", "new_knowledge_ids", "updated_knowledge_ids",
        "contradictions", "discoveries", "unresolved_unknowns", "redundant_with", "failures",
        "evidence_assessments", "signals", "recommendation", "reasoning", "scored_by",
    },
    "sched_schedules": {"depends_on", "retry", "concurrency", "resources", "metadata"},
    "sched_jobs": {"dependency_ids", "resources", "last_error", "decision_reasons", "metadata"},
    "sched_attempts": {"detail"},
    "sched_workers": {"capabilities", "metadata"},
    "sched_events": {"data"},
}

# Columns that are tri-state booleans: 1 / 0 / NULL (unknown). Decoded back from
# the stored int so the API returns a real bool (or None), not 1/0.
_NULLABLE_BOOL_COLS = {
    "research_results": {"hypothesis_survived"},
    "research_evaluations": {"llm_assisted"},
}

# Columns added after the initial schema. `CREATE TABLE IF NOT EXISTS` above does
# not touch an existing table, so these are applied idempotently on open for a
# database created before them.
_ADDED_COLUMNS: dict[str, dict[str, str]] = {
    "research_results": {"trace": "TEXT NOT NULL DEFAULT '[]'"},
}


async def _ensure_added_columns(conn: aiosqlite.Connection) -> None:
    for table, cols in _ADDED_COLUMNS.items():
        cur = await conn.execute(f"PRAGMA table_info({table})")
        existing = {row[1] for row in await cur.fetchall()}
        for col, decl in cols.items():
            if col not in existing:
                await conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {decl}")
                log.info("research store: added %s.%s", table, col)


class ResearchStore:
    """A thin SQLite wrapper. All methods are async; writes are serialised by the
    connection. Callers mutate a run through the loop, which persists via here."""

    def __init__(self, conn: aiosqlite.Connection):
        self._conn = conn

    # ── lifecycle ──
    @classmethod
    async def open(cls, path: Path | None = None) -> ResearchStore:
        p = path or research_db_path()
        p.parent.mkdir(parents=True, exist_ok=True)
        conn = await aiosqlite.connect(str(p))
        conn.row_factory = aiosqlite.Row
        await conn.executescript(_DDL)
        await _ensure_added_columns(conn)
        await conn.commit()
        log.info("research store ready at %s", p)
        return cls(conn)

    async def close(self) -> None:
        await self._conn.close()

    # ── generic helpers ──
    def _encode(self, table: str, values: dict[str, Any]) -> dict[str, Any]:
        json_cols = _JSON_COLS.get(table, set())
        out: dict[str, Any] = {}
        for k, v in values.items():
            if k in json_cols:
                out[k] = json.dumps(v, ensure_ascii=False, default=str)
            elif isinstance(v, bool):
                out[k] = 1 if v else 0
            else:
                out[k] = v
        return out

    def _decode(self, table: str, row: aiosqlite.Row | None) -> dict | None:
        if row is None:
            return None
        d = dict(row)
        for c in _JSON_COLS.get(table, set()):
            if c in d and isinstance(d[c], str):
                try:
                    d[c] = json.loads(d[c])
                except json.JSONDecodeError:
                    d[c] = None
        for c in _NULLABLE_BOOL_COLS.get(table, set()):
            if c in d:
                d[c] = None if d[c] is None else bool(d[c])
        return d

    async def _upsert(self, table: str, values: dict[str, Any], pk: str) -> None:
        enc = self._encode(table, values)
        cols = ", ".join(enc.keys())
        placeholders = ", ".join("?" for _ in enc)
        await self._conn.execute(
            f"INSERT OR REPLACE INTO {table} ({cols}) VALUES ({placeholders})",
            tuple(enc.values()),
        )
        await self._conn.commit()

    async def _fetchone(self, sql: str, args: tuple = ()) -> dict | None:
        table = _table_of(sql)
        cur = await self._conn.execute(sql, args)
        row = await cur.fetchone()
        return self._decode(table, row)

    async def _fetchall(self, sql: str, args: tuple = ()) -> list[dict]:
        table = _table_of(sql)
        cur = await self._conn.execute(sql, args)
        rows = await cur.fetchall()
        return [d for d in (self._decode(table, r) for r in rows) if d is not None]

    # ── runs (the State Manager) ──
    async def save_run(self, run: M.ResearchRun) -> None:
        await self._upsert("research_runs", run.to_row(), "id")

    async def get_run(self, run_id: str) -> M.ResearchRun | None:
        row = await self._fetchone("SELECT * FROM research_runs WHERE id=?", (run_id,))
        return M.ResearchRun.from_row(row) if row else None

    async def list_runs(self, *, status: str | None = None, limit: int = 50) -> list[M.ResearchRun]:
        if status:
            rows = await self._fetchall(
                "SELECT * FROM research_runs WHERE status=? ORDER BY updated_at DESC LIMIT ?", (status, limit)
            )
        else:
            rows = await self._fetchall("SELECT * FROM research_runs ORDER BY updated_at DESC LIMIT ?", (limit,))
        return [M.ResearchRun.from_row(r) for r in rows]

    # ── iterations ──
    async def save_iteration(self, it: M.ResearchIteration) -> None:
        await self._upsert("research_iterations", it.to_row(), "id")

    async def get_iteration(self, iteration_id: str) -> M.ResearchIteration | None:
        row = await self._fetchone("SELECT * FROM research_iterations WHERE id=?", (iteration_id,))
        return M.ResearchIteration.from_row(row) if row else None

    async def list_iterations(self, run_id: str, limit: int = 500) -> list[M.ResearchIteration]:
        rows = await self._fetchall(
            "SELECT * FROM research_iterations WHERE run_id=? ORDER BY idx ASC LIMIT ?", (run_id, limit)
        )
        return [M.ResearchIteration.from_row(r) for r in rows]

    # ── candidates ──
    async def save_candidates(self, run_id: str, cands: list[M.ResearchCandidate]) -> None:
        for c in cands:
            await self._upsert("research_candidates", {**c.to_row(), "run_id": run_id}, "id")

    async def get_candidate(self, candidate_id: str) -> M.ResearchCandidate | None:
        row = await self._fetchone("SELECT * FROM research_candidates WHERE id=?", (candidate_id,))
        return M.ResearchCandidate.from_row(row) if row else None

    async def list_candidates(self, run_id: str, *, status: str | None = None, limit: int = 500,
                              newest_first: bool = False) -> list[M.ResearchCandidate]:
        # `newest_first` matters: the prioritizer must see the *fresh* candidates.
        # Ordering by created_at ASC under a limit returns the oldest and silently
        # starves every new one once the open pool exceeds the limit.
        order = "DESC" if newest_first else "ASC"
        if status:
            rows = await self._fetchall(
                f"SELECT * FROM research_candidates WHERE run_id=? AND status=? ORDER BY created_at {order} LIMIT ?",
                (run_id, status, limit),
            )
        else:
            rows = await self._fetchall(
                f"SELECT * FROM research_candidates WHERE run_id=? ORDER BY created_at {order} LIMIT ?", (run_id, limit)
            )
        return [M.ResearchCandidate.from_row(r) for r in rows]

    async def candidate_question_keys(self, run_id: str) -> set[str]:
        """Normalised question keys already recorded for this run, any status —
        the anti-redundancy set the generator de-dupes against."""
        from .candidates import question_key

        rows = await self._fetchall(
            "SELECT question FROM research_candidates WHERE run_id=?", (run_id,)
        )
        return {question_key(r["question"]) for r in rows if r.get("question")}

    async def retire_duplicate_candidates(self, run_id: str, question_norm: str, keep_id: str) -> int:
        """Mark every other open candidate for the same normalised question as
        `abandoned`, so a chosen question is researched once, not once per
        duplicate row. Returns how many were retired."""
        from .candidates import question_key

        rows = await self._fetchall(
            "SELECT id, question FROM research_candidates WHERE run_id=? AND status='open'", (run_id,)
        )
        retired = 0
        for r in rows:
            if r["id"] == keep_id:
                continue
            if question_key(r.get("question") or "") == question_norm:
                await self.set_candidate_fields(r["id"], status="abandoned")
                retired += 1
        return retired

    async def set_candidate_fields(self, candidate_id: str, **fields: Any) -> None:
        if not fields:
            return
        enc = {k: (json.dumps(v, ensure_ascii=False) if isinstance(v, (dict, list)) else v) for k, v in fields.items()}
        sets = ", ".join(f"{k}=?" for k in enc)
        await self._conn.execute(f"UPDATE research_candidates SET {sets} WHERE id=?", (*enc.values(), candidate_id))
        await self._conn.commit()

    # ── plans ──
    async def save_plan(self, run_id: str, plan: M.ResearchPlan) -> None:
        await self._upsert("research_plans", {**plan.to_dict(), "run_id": run_id}, "id")

    async def get_plan(self, plan_id: str) -> M.ResearchPlan | None:
        row = await self._fetchone("SELECT * FROM research_plans WHERE id=?", (plan_id,))
        return M.ResearchPlan.from_dict(row) if row else None

    # ── results ──
    async def save_result(self, run_id: str, result: M.ResearchResult) -> None:
        await self._upsert("research_results", {**result.to_dict(), "run_id": run_id}, "id")

    async def get_result(self, result_id: str) -> M.ResearchResult | None:
        row = await self._fetchone("SELECT * FROM research_results WHERE id=?", (result_id,))
        return M.ResearchResult.from_dict(row) if row else None

    async def list_results(self, run_id: str, *, limit: int = 500) -> list[dict]:
        return await self._fetchall(
            "SELECT * FROM research_results WHERE run_id=? ORDER BY created_at ASC LIMIT ?",
            (run_id, limit),
        )

    # ── attempts (anti-redundancy ledger) ──
    async def record_attempt(self, attempt: dict) -> None:
        attempt.setdefault("id", M.new_id("at_"))
        attempt.setdefault("ts", M.now_ms())
        await self._upsert("research_attempts", attempt, "id")

    async def find_attempts(self, run_id: str, question_norm: str) -> list[dict]:
        return await self._fetchall(
            "SELECT * FROM research_attempts WHERE run_id=? AND question_norm=? ORDER BY ts DESC",
            (run_id, question_norm),
        )

    async def all_attempts(self, run_id: str, limit: int = 1000) -> list[dict]:
        return await self._fetchall(
            "SELECT * FROM research_attempts WHERE run_id=? ORDER BY ts DESC LIMIT ?", (run_id, limit)
        )

    # ── events ──
    async def record_event(self, event: ResearchEvent) -> None:
        ev = event
        await self._upsert(
            "research_events",
            {"id": ev.id, "run_id": ev.run_id, "type": ev.type, "iteration_index": ev.iteration_index, "data": ev.data, "ts": ev.ts},
            "id",
        )
        # best-effort JSONL mirror for tailing (off-thread: never block the loop)
        try:
            path = research_events_path()
            path.parent.mkdir(parents=True, exist_ok=True)
            line = json.dumps(ev.to_dict(), ensure_ascii=False)
            await asyncio.to_thread(_append_line, path, line)
        except OSError:
            pass

    async def list_events(self, run_id: str, *, since_ts: int = 0, limit: int = 2000) -> list[dict]:
        return await self._fetchall(
            "SELECT * FROM research_events WHERE run_id=? AND ts>? ORDER BY ts ASC LIMIT ?",
            (run_id, since_ts, limit),
        )

    # ── evaluations (the Research Evaluator's output) ──
    async def save_evaluation(self, evaluation: Any) -> None:
        await self._upsert("research_evaluations", evaluation.to_row(), "id")

    async def get_evaluation(self, evaluation_id: str) -> dict | None:
        return await self._fetchone("SELECT * FROM research_evaluations WHERE id=?", (evaluation_id,))

    async def get_iteration_evaluation(self, iteration_id: str) -> dict | None:
        return await self._fetchone(
            "SELECT * FROM research_evaluations WHERE iteration_id=? ORDER BY created_at DESC LIMIT 1",
            (iteration_id,),
        )

    async def list_evaluations(self, run_id: str, *, limit: int = 500) -> list[dict]:
        return await self._fetchall(
            "SELECT * FROM research_evaluations WHERE research_run_id=? ORDER BY created_at ASC LIMIT ?",
            (run_id, limit),
        )

    # The scalar dimensions + the small structured fields, with the three heavy
    # arrays (evidence_assessments, unresolved_unknowns, reasoning) collapsed to
    # their lengths. Enough for the UI to filter, score and chart every evaluation
    # of a large run without shipping tens of megabytes; the full record stays
    # reachable one at a time via get_evaluation.
    _LEAN_EVAL_COLS = (
        "id, research_run_id, iteration_id, status, strategy, llm_assisted, created_at, "
        "result_quality, evidence_quality, source_quality, relevance, completeness, novelty, "
        "knowledge_gain, uncertainty_reduction, objective_progress, confidence, "
        "signals, recommendation, failures, "
        "json_array_length(evidence_assessments) AS n_evidence, "
        "json_array_length(contradictions) AS n_contradictions, "
        "json_array_length(discoveries) AS n_discoveries, "
        "json_array_length(unresolved_unknowns) AS n_unknowns, "
        "json_array_length(answered_questions) AS n_answered, "
        "json_array_length(unanswered_questions) AS n_unanswered, "
        "json_array_length(scored_by) AS n_scored_by"
    )

    async def list_evaluations_lean(self, run_id: str, *, limit: int = 20000) -> list[dict]:
        return await self._fetchall(
            f"SELECT {self._LEAN_EVAL_COLS} FROM research_evaluations "
            "WHERE research_run_id=? ORDER BY created_at ASC LIMIT ?",
            (run_id, limit),
        )

    async def count_iterations(self, run_id: str) -> int:
        row = await self._fetchone("SELECT count(*) AS n FROM research_iterations WHERE run_id=?", (run_id,))
        return int(row["n"]) if row else 0

    async def count_evaluations(self, run_id: str) -> int:
        row = await self._fetchone(
            "SELECT count(*) AS n FROM research_evaluations WHERE research_run_id=?", (run_id,)
        )
        return int(row["n"]) if row else 0

    # ── scheduler: schedules ──
    async def save_schedule(self, schedule) -> None:
        await self._upsert("sched_schedules", schedule.to_row(), "id")

    async def get_schedule(self, schedule_id: str) -> dict | None:
        return await self._fetchone("SELECT * FROM sched_schedules WHERE id=?", (schedule_id,))

    async def list_schedules(
        self, *, status: str | None = None, research_run_id: str | None = None, limit: int = 1000
    ) -> list[dict]:
        if status and research_run_id:
            return await self._fetchall(
                "SELECT * FROM sched_schedules WHERE status=? AND research_run_id=? ORDER BY created_at ASC LIMIT ?",
                (status, research_run_id, limit),
            )
        if status:
            return await self._fetchall(
                "SELECT * FROM sched_schedules WHERE status=? ORDER BY created_at ASC LIMIT ?", (status, limit)
            )
        if research_run_id:
            return await self._fetchall(
                "SELECT * FROM sched_schedules WHERE research_run_id=? ORDER BY created_at ASC LIMIT ?",
                (research_run_id, limit),
            )
        return await self._fetchall("SELECT * FROM sched_schedules ORDER BY created_at ASC LIMIT ?", (limit,))

    async def set_schedule_fields(self, schedule_id: str, **fields: Any) -> None:
        await self._update_fields("sched_schedules", schedule_id, fields)

    # ── scheduler: jobs ──
    async def save_job(self, job) -> None:
        await self._upsert("sched_jobs", job.to_row(), "id")

    async def get_job(self, job_id: str) -> dict | None:
        return await self._fetchone("SELECT * FROM sched_jobs WHERE id=?", (job_id,))

    async def find_job_by_idempotency(self, key: str) -> dict | None:
        if not key:
            return None
        return await self._fetchone("SELECT * FROM sched_jobs WHERE idempotency_key=?", (key,))

    async def list_jobs(
        self, *, status: str | list[str] | None = None, schedule_id: str | None = None,
        research_run_id: str | None = None, limit: int = 1000,
    ) -> list[dict]:
        where: list[str] = []
        args: list[Any] = []
        if status:
            if isinstance(status, str):
                where.append("status=?")
                args.append(status)
            else:
                placeholders = ",".join("?" for _ in status)
                where.append(f"status IN ({placeholders})")
                args.extend(status)
        if schedule_id:
            where.append("schedule_id=?")
            args.append(schedule_id)
        if research_run_id:
            where.append("research_run_id=?")
            args.append(research_run_id)
        clause = ("WHERE " + " AND ".join(where)) if where else ""
        args.append(limit)
        return await self._fetchall(
            f"SELECT * FROM sched_jobs {clause} ORDER BY scheduled_at ASC LIMIT ?", tuple(args)
        )

    async def count_active_jobs_for_run(self, research_run_id: str) -> int:
        cur = await self._conn.execute(
            "SELECT COUNT(*) FROM sched_jobs WHERE research_run_id=? AND status IN ('RUNNING','CHECKPOINTING')",
            (research_run_id,),
        )
        row = await cur.fetchone()
        return int(row[0]) if row else 0

    async def count_jobs_by_status(self, *, statuses: tuple[str, ...] | None = None) -> dict[str, int]:
        """Count jobs grouped by status. With `statuses`, only those are counted —
        used by backpressure, which must ignore terminal jobs (counting completed
        jobs forever would make the depth never fall and refuse all new work)."""
        if statuses:
            placeholders = ",".join("?" * len(statuses))
            cur = await self._conn.execute(
                f"SELECT status, COUNT(*) FROM sched_jobs WHERE status IN ({placeholders}) GROUP BY status",
                statuses,
            )
        else:
            cur = await self._conn.execute("SELECT status, COUNT(*) FROM sched_jobs GROUP BY status")
        rows = await cur.fetchall()
        return {r[0]: int(r[1]) for r in rows}

    async def set_job_fields(self, job_id: str, **fields: Any) -> None:
        await self._update_fields("sched_jobs", job_id, fields)

    # ── scheduler: execution attempts ──
    async def save_attempt(self, attempt) -> None:
        await self._upsert("sched_attempts", attempt.to_row(), "id")

    async def list_attempts(self, job_id: str, *, limit: int = 100) -> list[dict]:
        return await self._fetchall(
            "SELECT * FROM sched_attempts WHERE job_id=? ORDER BY started_at ASC LIMIT ?", (job_id, limit)
        )

    # ── scheduler: leases ──
    async def put_lease(self, lease) -> None:
        await self._upsert("sched_leases", lease.to_row(), "job_id")

    async def acquire_lease(self, lease, *, now: int) -> bool:
        """Atomically claim `job_id` iff no *live* lease holds it.

        Insert-or-replace in one statement, guarded by `expires_at <= now`, so the
        read-then-write race of a separate get+put cannot let two callers both
        believe they hold the lease. Returns True when this caller now holds it,
        False when a non-expired lease already does."""
        row = lease.to_row()
        cur = await self._conn.execute(
            """
            INSERT INTO sched_leases
                (job_id, worker_id, lease_id, acquired_at, expires_at, heartbeat_at)
            VALUES (:job_id, :worker_id, :lease_id, :acquired_at, :expires_at, :heartbeat_at)
            ON CONFLICT(job_id) DO UPDATE SET
                worker_id=excluded.worker_id,
                lease_id=excluded.lease_id,
                acquired_at=excluded.acquired_at,
                expires_at=excluded.expires_at,
                heartbeat_at=excluded.heartbeat_at
            WHERE sched_leases.expires_at <= :now
            """,
            {**row, "now": now},
        )
        await self._conn.commit()
        return cur.rowcount == 1

    async def get_lease(self, job_id: str) -> dict | None:
        return await self._fetchone("SELECT * FROM sched_leases WHERE job_id=?", (job_id,))

    async def delete_lease(self, job_id: str) -> None:
        await self._conn.execute("DELETE FROM sched_leases WHERE job_id=?", (job_id,))
        await self._conn.commit()

    async def list_leases(self) -> list[dict]:
        return await self._fetchall("SELECT * FROM sched_leases ORDER BY acquired_at ASC", ())

    # ── scheduler: workers ──
    async def save_worker(self, worker) -> None:
        await self._upsert("sched_workers", worker.to_row(), "id")

    async def get_worker(self, worker_id: str) -> dict | None:
        return await self._fetchone("SELECT * FROM sched_workers WHERE id=?", (worker_id,))

    async def list_workers(self) -> list[dict]:
        return await self._fetchall("SELECT * FROM sched_workers ORDER BY started_at ASC", ())

    # ── scheduler: events (append-only) ──
    async def record_sched_event(self, event_id: str, type_: str, *, job_id: str = "", schedule_id: str = "",
                                 ts: int, **data: Any) -> None:
        await self._upsert(
            "sched_events",
            {"id": event_id, "job_id": job_id, "schedule_id": schedule_id, "type": type_,
             "data": data, "ts": ts},
            "id",
        )

    async def list_sched_events(self, *, since_ts: int = 0, limit: int = 1000) -> list[dict]:
        return await self._fetchall(
            "SELECT * FROM sched_events WHERE ts>? ORDER BY ts ASC LIMIT ?", (since_ts, limit)
        )

    async def _update_fields(self, table: str, pk_value: str, fields: dict[str, Any]) -> None:
        if not fields:
            return
        enc = self._encode(table, fields)
        sets = ", ".join(f"{k}=?" for k in enc)
        await self._conn.execute(f"UPDATE {table} SET {sets} WHERE id=?", (*enc.values(), pk_value))
        await self._conn.commit()


# ── process-wide instance (like the other agent stores) ──

_store: ResearchStore | None = None


async def init_research_store() -> ResearchStore:
    global _store
    if _store is None:
        _store = await ResearchStore.open()
    return _store


async def close_research_store() -> None:
    global _store
    if _store is not None:
        await _store.close()
        _store = None


def get_research_store() -> ResearchStore:
    if _store is None:
        raise RuntimeError("research store not initialized")
    return _store
