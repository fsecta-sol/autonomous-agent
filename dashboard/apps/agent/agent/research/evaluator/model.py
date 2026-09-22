"""Canonical model for the Research Evaluator.

An evaluation is a *decision-support record*, not a score: alongside numeric
dimensions it carries the evidence taxonomy, the contradictions and discoveries
it found, the failures it classified, the named signals it derived, and the
recommendation it hands to the NextActionSelector.

Dataclasses with `to_dict`/`from_dict`, matching the rest of `agent.research`, so
an evaluation round-trips through the SQLite store and the HTTP API unchanged.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field

from ..models import new_id, now_ms

# ── evaluation status (spec §4) ──────────────────────────────────────────────
STATUS_SUCCESS = "SUCCESS"
STATUS_PARTIAL_SUCCESS = "PARTIAL_SUCCESS"
STATUS_NO_PROGRESS = "NO_PROGRESS"
STATUS_FAILED = "FAILED"
STATUS_BLOCKED = "BLOCKED"

EVAL_STATUSES = (STATUS_SUCCESS, STATUS_PARTIAL_SUCCESS, STATUS_NO_PROGRESS, STATUS_FAILED, STATUS_BLOCKED)

# ── evidence taxonomy (spec §5) — what *kind of claim* a piece of output is ──
LEVEL_OBSERVATION = "OBSERVATION"
LEVEL_INTERPRETATION = "INTERPRETATION"
LEVEL_INFERENCE = "INFERENCE"
LEVEL_CONCLUSION = "CONCLUSION"
LEVEL_UNSUPPORTED = "UNSUPPORTED"

EVIDENCE_LEVELS = (
    LEVEL_OBSERVATION,
    LEVEL_INTERPRETATION,
    LEVEL_INFERENCE,
    LEVEL_CONCLUSION,
    LEVEL_UNSUPPORTED,
)

# ── evidence strength (spec §6) — how *well supported* a claim is ────────────
STRENGTH_DIRECT = "DIRECT"
STRENGTH_CORROBORATED = "CORROBORATED"
STRENGTH_INDIRECT = "INDIRECT"
STRENGTH_WEAK = "WEAK"
STRENGTH_UNSUPPORTED = "UNSUPPORTED"
STRENGTH_CONTRADICTED = "CONTRADICTED"

# ordered strongest → weakest; the evaluator ranks against this
STRENGTH_ORDER = {
    STRENGTH_CORROBORATED: 5,
    STRENGTH_DIRECT: 4,
    STRENGTH_INDIRECT: 3,
    STRENGTH_WEAK: 2,
    STRENGTH_UNSUPPORTED: 1,
    STRENGTH_CONTRADICTED: 0,
}
# numeric value each strength contributes to a quality score
STRENGTH_VALUE = {
    STRENGTH_CORROBORATED: 1.0,
    STRENGTH_DIRECT: 0.9,
    STRENGTH_INDIRECT: 0.55,
    STRENGTH_WEAK: 0.3,
    STRENGTH_UNSUPPORTED: 0.1,
    STRENGTH_CONTRADICTED: 0.0,
}

# ── named signals the evaluator emits (consumed by decision modules) ─────────
SIG_RETRY_TRANSIENT = "RETRY_TRANSIENT"
SIG_RETRY_STRATEGY_CHANGE = "RETRY_WITH_NEW_STRATEGY"
SIG_BRANCH = "BRANCH_NEW_DIRECTION"
SIG_CONTINUE = "CONTINUE"
SIG_STOP_SATISFIED = "STOP_OBJECTIVE_SATISFIED"
SIG_STOP_NO_PROGRESS = "STOP_NO_PROGRESS"
SIG_BROADEN = "BROADEN_QUESTION"
SIG_VERIFY = "SEEK_CORROBORATION"
SIG_RESOLVE_CONFLICT = "RESOLVE_CONTRADICTION"
SIG_LOW_VALUE = "LOW_VALUE_ITERATION"

SIGNAL_NAMES = (
    SIG_RETRY_TRANSIENT,
    SIG_RETRY_STRATEGY_CHANGE,
    SIG_BRANCH,
    SIG_CONTINUE,
    SIG_STOP_SATISFIED,
    SIG_STOP_NO_PROGRESS,
    SIG_BROADEN,
    SIG_VERIFY,
    SIG_RESOLVE_CONFLICT,
    SIG_LOW_VALUE,
)


@dataclass
class EvidenceAssessment:
    """One item of evidence, classified and graded, with its rationale."""

    evidence_id: str
    statement: str = ""
    kind: str = ""                 # observation | source | experiment | ...
    level: str = LEVEL_OBSERVATION  # the taxonomy level
    strength: str = STRENGTH_WEAK   # the strength category
    value: float = 0.3              # numeric strength (STRENGTH_VALUE)
    source: str = ""
    corroborated_by: list[str] = field(default_factory=list)
    rationale: str = ""

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> EvidenceAssessment:
        return cls(**{k: v for k, v in d.items() if k in cls.__dataclass_fields__})


@dataclass
class Contradiction:
    id: str
    subject: str = ""
    claim: str = ""
    conflicts_with: str = ""
    severity: str = "medium"  # low | medium | high
    evidence: list[str] = field(default_factory=list)
    resolved: bool = False
    rationale: str = ""

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> Contradiction:
        return cls(**{k: v for k, v in d.items() if k in cls.__dataclass_fields__})


@dataclass
class Discovery:
    """Something genuinely new the iteration surfaced (not a restatement)."""

    id: str
    statement: str = ""
    kind: str = "fact"  # fact | relationship | unknown | hypothesis | capability
    confidence: float = 0.5
    related_knowledge: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> Discovery:
        return cls(**{k: v for k, v in d.items() if k in cls.__dataclass_fields__})


@dataclass
class Unknown:
    """An open question this iteration left behind (new or still-unresolved)."""

    id: str
    question: str = ""
    severity: str = "medium"
    source: str = ""  # uncertainty | gap | conflict

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> Unknown:
        return cls(**{k: v for k, v in d.items() if k in cls.__dataclass_fields__})


@dataclass
class EvaluationFailure:
    """A classified failure — a type, whether it is retryable, and why."""

    kind: str = ""
    reason: str = ""
    strategy: str = ""
    retryable: bool = False
    attempts: int = 0

    def memory_safe(self) -> str:
        """A short, one-line form for the reasoning block."""
        return f"failure {self.kind}: {self.reason[:80]}" if self.reason else f"failure {self.kind}"

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> EvaluationFailure:
        return cls(**{k: v for k, v in d.items() if k in cls.__dataclass_fields__})


@dataclass
class EvaluationSignal:
    """A named decision signal with a direction and weight. The decision modules
    (NextActionSelector, StopConditionEvaluator) read these instead of re-deriving
    policy from raw scores."""

    name: str
    direction: str = "neutral"  # positive | negative | neutral
    weight: float = 0.0
    reason: str = ""

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> EvaluationSignal:
        return cls(**{k: v for k, v in d.items() if k in cls.__dataclass_fields__})


@dataclass
class DimensionScore:
    """One scored dimension, with the rationale that explains the number."""

    name: str
    score: float = 0.0
    weight: float = 1.0
    rationale: str = ""

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> DimensionScore:
        return cls(**{k: v for k, v in d.items() if k in cls.__dataclass_fields__})


@dataclass
class Recommendation:
    """The decision-support output: what the loop should consider next."""

    action: str = ""                 # a models.ACTION_* value
    reason: str = ""
    suggested_strategy: str = ""
    suggested_focus: str = ""
    confidence: float = 0.0
    signals: list[str] = field(default_factory=list)  # signal names that drove it

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> Recommendation:
        return cls(**{k: v for k, v in d.items() if k in cls.__dataclass_fields__})


@dataclass
class EvaluationReasoning:
    """Why the evaluation reached its conclusion — inspectable in debug mode."""

    summary: str = ""
    steps: list[str] = field(default_factory=list)
    dimensions: list[dict] = field(default_factory=list)  # DimensionScore.to_dict()
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> EvaluationReasoning:
        return cls(**{k: v for k, v in d.items() if k in cls.__dataclass_fields__})


@dataclass
class ResearchEvaluation:
    """The canonical evaluation of one research iteration."""

    id: str
    research_run_id: str
    iteration_id: str
    status: str = STATUS_NO_PROGRESS

    # dimensions, each 0..1
    result_quality: float = 0.0
    evidence_quality: float = 0.0
    source_quality: float = 0.0
    relevance: float = 0.0
    completeness: float = 0.0
    novelty: float = 0.0
    knowledge_gain: float = 0.0
    uncertainty_reduction: float = 0.0
    objective_progress: float = 0.0
    confidence: float = 0.0

    # structured findings
    answered_questions: list[str] = field(default_factory=list)
    unanswered_questions: list[str] = field(default_factory=list)
    new_knowledge_ids: list[str] = field(default_factory=list)
    updated_knowledge_ids: list[str] = field(default_factory=list)
    contradictions: list[dict] = field(default_factory=list)      # Contradiction.to_dict()
    discoveries: list[dict] = field(default_factory=list)         # Discovery.to_dict()
    unresolved_unknowns: list[dict] = field(default_factory=list) # Unknown.to_dict()
    redundant_with: list[str] = field(default_factory=list)
    failures: list[dict] = field(default_factory=list)            # EvaluationFailure.to_dict()
    evidence_assessments: list[dict] = field(default_factory=list)  # EvidenceAssessment.to_dict()

    signals: list[dict] = field(default_factory=list)             # EvaluationSignal.to_dict()
    recommendation: dict = field(default_factory=dict)            # Recommendation.to_dict()
    reasoning: dict = field(default_factory=dict)                 # EvaluationReasoning.to_dict()

    # provenance
    strategy: str = ""
    scored_by: list[str] = field(default_factory=list)  # dimension names that ran
    llm_assisted: bool = False
    created_at: int = field(default_factory=now_ms)

    def score(self, name: str) -> float:
        return float(getattr(self, name, 0.0) or 0.0)

    def signal_names(self) -> list[str]:
        return [s.get("name", "") for s in self.signals]

    def to_row(self) -> dict:
        return asdict(self)

    @classmethod
    def from_row(cls, row: dict) -> ResearchEvaluation:
        return cls(**{k: v for k, v in row.items() if k in cls.__dataclass_fields__})

    def to_dict(self) -> dict:
        return asdict(self)

    def summary(self) -> dict:
        """A compact, camelCase view for the API/UI."""
        return {
            "id": self.id,
            "researchRunId": self.research_run_id,
            "iterationId": self.iteration_id,
            "status": self.status,
            "strategy": self.strategy,
            "dimensions": {
                "resultQuality": round(self.result_quality, 3),
                "evidenceQuality": round(self.evidence_quality, 3),
                "sourceQuality": round(self.source_quality, 3),
                "relevance": round(self.relevance, 3),
                "completeness": round(self.completeness, 3),
                "novelty": round(self.novelty, 3),
                "knowledgeGain": round(self.knowledge_gain, 3),
                "uncertaintyReduction": round(self.uncertainty_reduction, 3),
                "objectiveProgress": round(self.objective_progress, 3),
                "confidence": round(self.confidence, 3),
            },
            "counts": {
                "answered": len(self.answered_questions),
                "unanswered": len(self.unanswered_questions),
                "contradictions": len(self.contradictions),
                "discoveries": len(self.discoveries),
                "unknowns": len(self.unresolved_unknowns),
                "redundantWith": len(self.redundant_with),
                "failures": len(self.failures),
                "evidence": len(self.evidence_assessments),
            },
            "signals": [s.get("name") for s in self.signals],
            "recommendation": self.recommendation,
            "createdAt": self.created_at,
        }


def make_evaluation_id() -> str:
    return new_id("eval_")
