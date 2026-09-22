"""Data model for the Research Loop.

Everything the loop touches is a plain dataclass with `to_dict`/`from_dict`, so
it round-trips through the durable store (SQLite, JSON columns) and the HTTP API
without a schema framework. Enums are string constants (not `enum.Enum`) so they
serialise directly and tolerate unknown future values from an older client.

The persistent units, in the spec's vocabulary:

    ResearchRun     — the whole investigation (objective, budget, status)
    ResearchIteration — one loop cycle (hypothesis → plan → result → update)
    ResearchCandidate — a proposed thing to investigate, grounded in a gap
    ResearchPlan    — the steps a strategy will take
    ResearchResult  — evidence-first outcome (observations vs conclusions)
    Evaluation      — the structured read of a result's value
"""

from __future__ import annotations

import time
import uuid
from dataclasses import asdict, dataclass, field
from typing import Any

# ── enums ────────────────────────────────────────────────────────────────────

# A run's lifecycle. WAITING = paused for an external (human) decision;
# BLOCKED = a dependency cannot be satisfied; CANCELLED = operator stop.
RUN_PENDING = "PENDING"
RUN_RUNNING = "RUNNING"
RUN_PAUSED = "PAUSED"
RUN_WAITING = "WAITING"
RUN_BLOCKED = "BLOCKED"
RUN_COMPLETED = "COMPLETED"
RUN_CANCELLED = "CANCELLED"
RUN_FAILED = "FAILED"

RUN_STATUSES = frozenset(
    {RUN_PENDING, RUN_RUNNING, RUN_PAUSED, RUN_WAITING, RUN_BLOCKED, RUN_COMPLETED, RUN_CANCELLED, RUN_FAILED}
)
TERMINAL_RUN_STATUSES = frozenset({RUN_COMPLETED, RUN_CANCELLED, RUN_FAILED})

# The explicit state machine. Each iteration advances through these; a step()
# call runs exactly one stage transition's work, so the loop is interruptible.
STAGE_IDLE = "IDLE"
STAGE_LOADING_CONTEXT = "LOADING_CONTEXT"
STAGE_ANALYZING_KNOWLEDGE = "ANALYZING_KNOWLEDGE"
STAGE_GENERATING_CANDIDATES = "GENERATING_CANDIDATES"
STAGE_PRIORITIZING = "PRIORITIZING"
STAGE_PLANNING = "PLANNING"
STAGE_EXECUTING = "EXECUTING"
STAGE_COLLECTING_EVIDENCE = "COLLECTING_EVIDENCE"
STAGE_ANALYZING_RESULT = "ANALYZING_RESULT"
STAGE_UPDATING_KNOWLEDGE = "UPDATING_KNOWLEDGE"
STAGE_EVALUATING_PROGRESS = "EVALUATING_PROGRESS"
STAGE_DECIDING_NEXT_ACTION = "DECIDING_NEXT_ACTION"
STAGE_WAITING = "WAITING"
STAGE_DONE = "DONE"

STAGES = [
    STAGE_IDLE,
    STAGE_LOADING_CONTEXT,
    STAGE_ANALYZING_KNOWLEDGE,
    STAGE_GENERATING_CANDIDATES,
    STAGE_PRIORITIZING,
    STAGE_PLANNING,
    STAGE_EXECUTING,
    STAGE_COLLECTING_EVIDENCE,
    STAGE_ANALYZING_RESULT,
    STAGE_UPDATING_KNOWLEDGE,
    STAGE_EVALUATING_PROGRESS,
    STAGE_DECIDING_NEXT_ACTION,
    STAGE_WAITING,
    STAGE_DONE,
]

# How a candidate is integrated — the Knowledge Manager's decision, surfaced.
DISPOSITION_NEW = "NEW"
DISPOSITION_UPDATE = "UPDATE"
DISPOSITION_RELATED = "RELATED"
DISPOSITION_DUPLICATE = "DUPLICATE"
DISPOSITION_CONFLICT = "CONFLICT"

# Next action after an iteration.
ACTION_CONTINUE = "CONTINUE"
ACTION_BRANCH = "BRANCH"
ACTION_RETRY = "RETRY"
ACTION_WAIT = "WAIT"
ACTION_STOP = "STOP"

# Explicit failure kinds (spec §22).
FAIL_NONE = ""
FAIL_TOOL = "TOOL_FAILURE"
FAIL_SOURCE_UNAVAILABLE = "SOURCE_UNAVAILABLE"
FAIL_INSUFFICIENT_EVIDENCE = "INSUFFICIENT_EVIDENCE"
FAIL_HYPOTHESIS_REJECTED = "HYPOTHESIS_REJECTED"
FAIL_BLOCKED = "RESEARCH_BLOCKED"
FAIL_TIMEOUT = "TIMEOUT"
FAIL_BUDGET = "BUDGET_EXCEEDED"

FAILURE_KINDS = frozenset(
    {
        FAIL_NONE,
        FAIL_TOOL,
        FAIL_SOURCE_UNAVAILABLE,
        FAIL_INSUFFICIENT_EVIDENCE,
        FAIL_HYPOTHESIS_REJECTED,
        FAIL_BLOCKED,
        FAIL_TIMEOUT,
        FAIL_BUDGET,
    }
)

# Stop reasons (spec §20).
STOP_OBJECTIVE_SATISFIED = "OBJECTIVE_SATISFIED"
STOP_COVERAGE_REACHED = "KNOWLEDGE_COVERAGE_REACHED"
STOP_NO_RESEARCH = "NO_MEANINGFUL_RESEARCH_REMAINING"
STOP_BUDGET = "BUDGET_EXCEEDED"
STOP_ITERATION_LIMIT = "ITERATION_LIMIT_REACHED"
STOP_TIME_LIMIT = "TIME_LIMIT_REACHED"
STOP_USER_CANCELLED = "USER_CANCELLED"
STOP_BLOCKED = "BLOCKED"
STOP_REPEATED_FAILURE = "REPEATED_FAILURE"
STOP_DIMINISHING_RETURNS = "DIMINISHING_RETURNS"


def now_ms() -> int:
    return int(time.time() * 1000)


def new_id(prefix: str = "") -> str:
    raw = uuid.uuid4().hex[:12]
    return f"{prefix}{raw}" if prefix else raw


# ── dataclasses ──────────────────────────────────────────────────────────────


@dataclass
class Budget:
    """Hard ceilings for a run. `None` on a field means "no limit on this axis"."""

    max_iterations: int | None = 50
    max_tool_calls: int | None = None
    max_tokens: int | None = None
    max_wall_clock_s: float | None = 3600.0

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict | None) -> Budget:
        d = d or {}
        return cls(
            max_iterations=d.get("max_iterations", 50),
            max_tool_calls=d.get("max_tool_calls"),
            max_tokens=d.get("max_tokens"),
            max_wall_clock_s=d.get("max_wall_clock_s", 3600.0),
        )


@dataclass
class Progress:
    """Cumulative, information-gain-oriented progress (never raw task count)."""

    iterations: int = 0
    knowledge_created: int = 0
    knowledge_updated: int = 0
    unknowns_created: int = 0
    unknowns_resolved: int = 0
    conflicts_found: int = 0
    relationships_added: int = 0
    evidence_items: int = 0
    hypotheses_rejected: int = 0
    low_value_streak: int = 0
    info_gain: float = 0.0

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict | None) -> Progress:
        d = d or {}
        return cls(**{k: v for k, v in d.items() if k in cls.__dataclass_fields__})


@dataclass
class Objective:
    """What the run is trying to achieve, separate from any single task."""

    statement: str
    success_criteria: list[str] = field(default_factory=list)
    domain: str = ""

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> Objective:
        return cls(
            statement=d.get("statement", ""),
            success_criteria=list(d.get("success_criteria", []) or []),
            domain=d.get("domain", ""),
        )


@dataclass
class ResearchRun:
    """The persistent, resumable unit of research."""

    id: str
    objective: Objective
    status: str = RUN_PENDING
    stage: str = STAGE_IDLE
    iteration: int = 0
    started_at: int = field(default_factory=now_ms)
    updated_at: int = field(default_factory=now_ms)
    completed_at: int | None = None
    budget: Budget = field(default_factory=Budget)
    progress: Progress = field(default_factory=Progress)
    termination_reason: str = ""
    parent_run_id: str | None = None
    agent_id: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)
    # the iteration currently in flight, if any
    current_iteration_id: str | None = None
    # the selected candidate's id for the in-flight iteration
    current_candidate_id: str | None = None

    def is_terminal(self) -> bool:
        return self.status in TERMINAL_RUN_STATUSES

    def elapsed_s(self) -> float:
        end = self.completed_at or now_ms()
        return (end - self.started_at) / 1000.0

    def to_row(self) -> dict:
        return {
            "id": self.id,
            "objective": self.objective.to_dict(),
            "status": self.status,
            "stage": self.stage,
            "iteration": self.iteration,
            "started_at": self.started_at,
            "updated_at": self.updated_at,
            "completed_at": self.completed_at,
            "budget": self.budget.to_dict(),
            "progress": self.progress.to_dict(),
            "termination_reason": self.termination_reason,
            "parent_run_id": self.parent_run_id,
            "agent_id": self.agent_id,
            "metadata": self.metadata,
            "current_iteration_id": self.current_iteration_id,
            "current_candidate_id": self.current_candidate_id,
        }

    @classmethod
    def from_row(cls, row: dict) -> ResearchRun:
        return cls(
            id=row["id"],
            objective=Objective.from_dict(row["objective"]),
            status=row["status"],
            stage=row["stage"],
            iteration=row["iteration"],
            started_at=row["started_at"],
            updated_at=row["updated_at"],
            completed_at=row.get("completed_at"),
            budget=Budget.from_dict(row.get("budget")),
            progress=Progress.from_dict(row.get("progress")),
            termination_reason=row.get("termination_reason", ""),
            parent_run_id=row.get("parent_run_id"),
            agent_id=row.get("agent_id", ""),
            metadata=row.get("metadata") or {},
            current_iteration_id=row.get("current_iteration_id"),
            current_candidate_id=row.get("current_candidate_id"),
        )

    def summary(self) -> dict:
        return {
            "id": self.id,
            "objective": self.objective.statement,
            "success_criteria": self.objective.success_criteria,
            "status": self.status,
            "stage": self.stage,
            "iteration": self.iteration,
            "startedAt": self.started_at,
            "updatedAt": self.updated_at,
            "completedAt": self.completed_at,
            "elapsedS": round(self.elapsed_s(), 1),
            "budget": self.budget.to_dict(),
            "progress": self.progress.to_dict(),
            "terminationReason": self.termination_reason,
            "parentRunId": self.parent_run_id,
            "currentIterationId": self.current_iteration_id,
            "currentCandidateId": self.current_candidate_id,
        }


@dataclass
class ResearchCandidate:
    """A proposed investigation, grounded in a knowledge gap."""

    id: str
    question: str
    reason: str = ""
    objective: str = ""
    expected_information_gain: str = "medium"  # low | medium | high
    priority_hint: str = "medium"
    estimated_cost: str = "medium"  # low | medium | high
    risk: str = "low"
    related_knowledge: list[str] = field(default_factory=list)
    related_unknowns: list[str] = field(default_factory=list)
    related_conflicts: list[str] = field(default_factory=list)
    branch: str = "main"
    source_gap_kind: str = ""
    # filled in by the prioritizer
    priority: float = 0.0
    rank_inputs: dict[str, float] = field(default_factory=dict)
    status: str = "open"  # open | selected | done | failed | abandoned
    created_at: int = field(default_factory=now_ms)

    def to_row(self) -> dict:
        d = asdict(self)
        d["rank_inputs"] = dict(self.rank_inputs)
        return d

    @classmethod
    def from_row(cls, row: dict) -> ResearchCandidate:
        known = {k: row.get(k) for k in cls.__dataclass_fields__ if k in row}
        return cls(**known)

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class ResearchPlan:
    """The steps a strategy will take for one candidate."""

    id: str
    candidate_id: str
    question: str
    strategy: str
    steps: list[str] = field(default_factory=list)
    expected_evidence: list[str] = field(default_factory=list)
    success_conditions: list[str] = field(default_factory=list)
    failure_conditions: list[str] = field(default_factory=list)
    constraints: list[str] = field(default_factory=list)
    created_at: int = field(default_factory=now_ms)

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> ResearchPlan:
        return cls(**{k: v for k, v in d.items() if k in cls.__dataclass_fields__})


@dataclass
class Evidence:
    """A single piece of provenance: what was observed, from where."""

    kind: str  # observation | source | experiment | artifact | measurement
    statement: str
    source: str = ""  # URL, command, doc path, request id
    detail: str = ""
    collected_at: int = field(default_factory=now_ms)

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> Evidence:
        return cls(**{k: v for k, v in d.items() if k in cls.__dataclass_fields__})


@dataclass
class ResearchResult:
    """Evidence-first outcome: observations are kept apart from interpretation."""

    id: str
    candidate_id: str
    iteration_id: str
    strategy: str
    question: str = ""
    observations: list[dict] = field(default_factory=list)   # raw, low-inference
    evidence: list[dict] = field(default_factory=list)       # Evidence.to_dict()
    sources: list[str] = field(default_factory=list)
    experiments: list[dict] = field(default_factory=list)
    artifacts: list[str] = field(default_factory=list)
    conclusions: list[str] = field(default_factory=list)     # interpretation
    uncertainties: list[str] = field(default_factory=list)
    hypothesis_survived: bool | None = None
    failure_kind: str = FAIL_NONE
    failure_reason: str = ""
    cost: dict = field(default_factory=dict)  # {tool_calls, tokens, seconds}
    # The sub-agent's observable activity trail (thought / tool_call / tool_result
    # steps), captured at execution time. Empty for scripted/non-subagent runs.
    trace: list[dict] = field(default_factory=list)
    created_at: int = field(default_factory=now_ms)

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> ResearchResult:
        return cls(**{k: v for k, v in d.items() if k in cls.__dataclass_fields__})


@dataclass
class Evaluation:
    """The structured read of one result's value (spec §15)."""

    answered_question: bool = False
    new_evidence: bool = False
    knowledge_increased: bool = False
    uncertainty_reduced: bool = False
    new_unknowns: int = 0
    contradiction_created: bool = False
    hypothesis_survived: bool | None = None
    failed: bool = False
    failure_kind: str = FAIL_NONE
    info_gain: float = 0.0
    should_retry: bool = False
    should_branch: bool = False
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> Evaluation:
        return cls(**{k: v for k, v in d.items() if k in cls.__dataclass_fields__})


@dataclass
class ResearchIteration:
    """One loop cycle — enough to reconstruct exactly what happened."""

    id: str
    run_id: str
    index: int
    hypothesis: str = ""
    branch: str = "main"
    candidate_id: str | None = None
    plan_id: str | None = None
    result_id: str | None = None
    strategy: str = ""
    stage: str = STAGE_IDLE
    disposition: str = ""            # the Knowledge Manager's decision
    knowledge_updates: list[dict] = field(default_factory=list)
    evaluation: dict = field(default_factory=dict)
    next_action: str = ""
    next_reason: str = ""
    started_at: int = field(default_factory=now_ms)
    updated_at: int = field(default_factory=now_ms)
    finished_at: int | None = None

    def to_row(self) -> dict:
        d = asdict(self)
        d["idx"] = d.pop("index")  # column name is `idx`
        return d

    @classmethod
    def from_row(cls, row: dict) -> ResearchIteration:
        d = {k: v for k, v in row.items() if k in cls.__dataclass_fields__ or k == "idx"}
        if "idx" in d:
            d["index"] = d.pop("idx")
        return cls(**d)

    def to_dict(self) -> dict:
        return asdict(self)
