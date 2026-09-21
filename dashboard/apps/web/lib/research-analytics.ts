/**
 * Derived, operator-facing analytics for the Research UI — outcomes, failure
 * breakdowns and filter predicates over a run's iterations and evaluations.
 *
 * Everything here is pure and computed from the loaded data; nothing is
 * hardcoded and nothing is inferred from arbitrary prose. The outcome and
 * failure-kind vocabularies mirror the engine's authoritative enums
 * (`research/models.py` FAIL_* / ACTION_* / iteration disposition, and
 * `evaluator/model.py` STATUS_*), so classification follows the backend's own
 * fields rather than string-matching free text.
 */

import type {
  Evaluation,
  EvaluationFailure,
  Iteration,
  Recommendation,
  ResearchEvaluationLean,
  RunStatus,
} from "./research-loop";

/* ── iteration outcome ─────────────────────────────────────────────────────── */

/** The recognizable state of one iteration, derived from the engine's fields. */
export type IterationOutcome = "SUCCESS" | "PARTIAL" | "FAILED" | "TIMEOUT" | "RUNNING" | "PENDING";

export const OUTCOME_MARK: Record<IterationOutcome, string> = {
  SUCCESS: "✓",
  PARTIAL: "◐",
  FAILED: "×",
  TIMEOUT: "⚠",
  RUNNING: "●",
  PENDING: "○",
};

export const OUTCOME_LABEL: Record<IterationOutcome, string> = {
  SUCCESS: "Success",
  PARTIAL: "Partial",
  FAILED: "Failed",
  TIMEOUT: "Timeout",
  RUNNING: "Running",
  PENDING: "Pending",
};

/** Outcome → CSS tone (used for the row mark's data-tone). */
export function outcomeTone(o: IterationOutcome): "ok" | "warn" | "err" | "run" | "stop" {
  switch (o) {
    case "SUCCESS":
      return "ok";
    case "PARTIAL":
      return "warn";
    case "FAILED":
    case "TIMEOUT":
      return "err";
    case "RUNNING":
      return "run";
    case "PENDING":
      return "stop";
  }
}

/**
 * Whether the loop chose to re-run this iteration (its next action was RETRY).
 * Retry is a *separate axis* from outcome, not an outcome of its own: an
 * iteration that timed out and was then retried is both TIMEOUT and retried, and
 * the operator must see both. Collapsing them would hide the failure.
 */
export function isRetried(it: Iteration): boolean {
  return it.next_action === "RETRY";
}

/**
 * Classify one iteration from the engine's own fields.
 *
 * - an unfinished iteration is RUNNING in a running run, else PENDING;
 * - a finished one whose evaluation flagged `failed` is TIMEOUT when its
 *   `failure_kind` is TIMEOUT, else FAILED;
 * - otherwise it succeeded; when the evaluation says the question was not
 *   answered or the hypothesis was rejected, that is PARTIAL rather than SUCCESS.
 *
 * The retry axis is orthogonal — see `isRetried`.
 */
export function classifyIteration(it: Iteration, runStatus?: RunStatus): IterationOutcome {
  if (it.finished_at == null) {
    return runStatus === "RUNNING" ? "RUNNING" : "PENDING";
  }
  const ev = (it.evaluation ?? {}) as Evaluation;
  if (ev.failed) return ev.failure_kind === "TIMEOUT" ? "TIMEOUT" : "FAILED";
  if (ev.hypothesis_survived === false) return "PARTIAL";
  if (ev.answered_question === false) return "PARTIAL";
  return "SUCCESS";
}

/** Iteration categories (the engine's strategy registry names). */
export function iterationCategory(it: Iteration): string {
  return it.strategy || "unplanned";
}

export function categoryLabel(name: string): string {
  const map: Record<string, string> = {
    documentation: "Documentation",
    web: "Web",
    experiment: "Experiment",
    "source-comparison": "Source comparison",
    source_comparison: "Source comparison",
    unplanned: "Unplanned",
  };
  return map[name] ?? name.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/* ── failure kinds ─────────────────────────────────────────────────────────── */

/** Operator-facing labels for the engine's FAIL_* kinds. */
export const FAILURE_LABEL: Record<string, string> = {
  TIMEOUT: "Timeout",
  TOOL_FAILURE: "Tool failure",
  SOURCE_UNAVAILABLE: "Source unavailable",
  INSUFFICIENT_EVIDENCE: "No evidence",
  HYPOTHESIS_REJECTED: "Hypothesis rejected",
  RESEARCH_BLOCKED: "Blocked",
  BUDGET_EXCEEDED: "Budget exceeded",
};

export function failureLabel(kind: string): string {
  return FAILURE_LABEL[kind] ?? (kind ? kind.replace(/_/g, " ").toLowerCase() : "Unknown");
}

/** The failure_kind of a finished iteration ("" = none). */
export function iterationFailureKind(it: Iteration): string {
  const ev = (it.evaluation ?? {}) as Evaluation;
  return ev.failed ? ev.failure_kind || "UNKNOWN" : "";
}

/** The status filter a failure kind maps to when its breakdown row is clicked. */
export function failureKindToOutcome(kind: string): IterationOutcome {
  return kind === "TIMEOUT" ? "TIMEOUT" : "FAILED";
}

/* ── run analytics (the failure strip + breakdown) ─────────────────────────── */

export interface FailureRow {
  kind: string;
  label: string;
  count: number;
  /** share of evaluated iterations, 0..100 */
  pct: number;
}

export interface RunAnalytics {
  /** iterations in the loaded dataset */
  total: number;
  /** finished iterations — the denominator for every rate (running/pending excluded) */
  evaluated: number;
  counts: Record<IterationOutcome, number>;
  successPct: number;
  partialPct: number;
  /** (FAILED + TIMEOUT) / evaluated */
  failedPct: number;
  timeoutPct: number;
  /** iterations the loop chose to retry / evaluated (an axis, not an outcome) */
  retried: number;
  retryPct: number;
  /** grouped by engine failure_kind, largest first */
  failureBreakdown: FailureRow[];
}

export function pct(n: number, d: number): number {
  return d > 0 ? (n / d) * 100 : 0;
}

/** Compute the run's health analytics from its iterations. */
export function computeRunAnalytics(iterations: Iteration[], runStatus?: RunStatus): RunAnalytics {
  const counts: Record<IterationOutcome, number> = {
    SUCCESS: 0,
    PARTIAL: 0,
    FAILED: 0,
    TIMEOUT: 0,
    RUNNING: 0,
    PENDING: 0,
  };
  const failures = new Map<string, number>();
  let evaluated = 0;
  let retried = 0;

  for (const it of iterations) {
    const o = classifyIteration(it, runStatus);
    counts[o] += 1;
    if (o === "RUNNING" || o === "PENDING") continue;
    evaluated += 1;
    if (isRetried(it)) retried += 1;
    const fk = iterationFailureKind(it);
    if (fk) failures.set(fk, (failures.get(fk) ?? 0) + 1);
  }

  const failed = counts.FAILED + counts.TIMEOUT;
  const failureBreakdown: FailureRow[] = [...failures.entries()]
    .map(([kind, count]) => ({ kind, label: failureLabel(kind), count, pct: pct(count, evaluated) }))
    .sort((a, b) => b.count - a.count);

  return {
    total: iterations.length,
    evaluated,
    counts,
    successPct: pct(counts.SUCCESS, evaluated),
    partialPct: pct(counts.PARTIAL, evaluated),
    failedPct: pct(failed, evaluated),
    timeoutPct: pct(counts.TIMEOUT, evaluated),
    retried,
    retryPct: pct(retried, evaluated),
    failureBreakdown,
  };
}

/* ── evaluation analytics ──────────────────────────────────────────────────── */

/** Confidence buckets (a documented convention, not engine data). */
export type ConfidenceBand = "high" | "medium" | "low";
export const CONFIDENCE_HIGH = 0.8;
export const CONFIDENCE_MEDIUM = 0.5;

export function confidenceBand(c: number): ConfidenceBand {
  if (c >= CONFIDENCE_HIGH) return "high";
  if (c >= CONFIDENCE_MEDIUM) return "medium";
  return "low";
}

export interface EvaluationAnalytics {
  total: number;
  statusCounts: Record<string, number>;
  /** SUCCESS / total */
  passedPct: number;
  partialPct: number;
  /** FAILED / total */
  failedPct: number;
  blockedPct: number;
  /** recommendations whose action is RETRY / total */
  retryPct: number;
  avgConfidence: number;
  avgKnowledgeGain: number;
  failureBreakdown: FailureRow[];
}

function recAction(ev: ResearchEvaluationLean): string {
  const rec = ev.recommendation as Recommendation | Record<string, never> | undefined;
  if (rec && typeof rec === "object" && "action" in rec && typeof rec.action === "string") return rec.action;
  return "";
}

export function computeEvaluationAnalytics(evals: ResearchEvaluationLean[]): EvaluationAnalytics {
  const statusCounts: Record<string, number> = {};
  const failures = new Map<string, number>();
  let retries = 0;
  let confSum = 0;
  let gainSum = 0;

  for (const ev of evals) {
    statusCounts[ev.status] = (statusCounts[ev.status] ?? 0) + 1;
    if (recAction(ev) === "RETRY") retries += 1;
    confSum += ev.confidence || 0;
    gainSum += ev.knowledge_gain || 0;
    for (const f of ev.failures ?? []) {
      const kind = (f as EvaluationFailure).kind || "UNKNOWN";
      failures.set(kind, (failures.get(kind) ?? 0) + 1);
    }
  }

  const total = evals.length;
  const failureBreakdown: FailureRow[] = [...failures.entries()]
    .map(([kind, count]) => ({ kind, label: failureLabel(kind), count, pct: pct(count, total) }))
    .sort((a, b) => b.count - a.count);

  return {
    total,
    statusCounts,
    passedPct: pct(statusCounts.SUCCESS ?? 0, total),
    partialPct: pct(statusCounts.PARTIAL_SUCCESS ?? 0, total),
    failedPct: pct(statusCounts.FAILED ?? 0, total),
    blockedPct: pct(statusCounts.BLOCKED ?? 0, total),
    retryPct: pct(retries, total),
    avgConfidence: total ? confSum / total : 0,
    avgKnowledgeGain: total ? gainSum / total : 0,
    failureBreakdown,
  };
}

/* ── filter predicates ─────────────────────────────────────────────────────── */

export interface NumericFilter {
  key: string; // a scalar dimension key on ResearchEvaluationLean
  op: ">=" | "<=";
  value: number;
}

export interface TimelineFilters {
  status: IterationOutcome | "ALL";
  category: string | "ALL";
  decision: string | "ALL";
  /** only iterations the loop chose to retry (an axis, combinable with status) */
  retried: boolean;
  search: string;
}

export interface EvaluationFilters {
  status: string | "ALL";
  confidence: ConfidenceBand | "ALL";
  numeric: NumericFilter[];
  search: string;
}

export function emptyTimelineFilters(): TimelineFilters {
  return { status: "ALL", category: "ALL", decision: "ALL", retried: false, search: "" };
}

export function emptyEvaluationFilters(): EvaluationFilters {
  return { status: "ALL", confidence: "ALL", numeric: [], search: "" };
}

/** Count of active, non-default Timeline filters (for the toolbar's badge). */
export function timelineFilterCount(f: TimelineFilters): number {
  return (
    (f.status !== "ALL" ? 1 : 0) +
    (f.category !== "ALL" ? 1 : 0) +
    (f.decision !== "ALL" ? 1 : 0) +
    (f.retried ? 1 : 0) +
    (f.search.trim() ? 1 : 0)
  );
}

export function evaluationFilterCount(f: EvaluationFilters): number {
  return (f.status !== "ALL" ? 1 : 0) + (f.confidence !== "ALL" ? 1 : 0) + f.numeric.length + (f.search.trim() ? 1 : 0);
}

export function matchesTimeline(it: Iteration, f: TimelineFilters, runStatus?: RunStatus): boolean {
  if (f.status !== "ALL" && classifyIteration(it, runStatus) !== f.status) return false;
  if (f.retried && !isRetried(it)) return false;
  if (f.category !== "ALL" && iterationCategory(it) !== f.category) return false;
  if (f.decision !== "ALL" && it.next_action !== f.decision) return false;
  const q = f.search.trim().toLowerCase();
  if (q) {
    const hay = `${it.index}\n${it.hypothesis}\n${it.strategy}\n${it.next_reason}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

export function matchesEvaluation(ev: ResearchEvaluationLean, f: EvaluationFilters): boolean {
  if (f.status === "RETRY") {
    if (recAction(ev) !== "RETRY") return false;
  } else if (f.status !== "ALL" && ev.status !== f.status) {
    return false;
  }
  if (f.confidence !== "ALL" && confidenceBand(ev.confidence) !== f.confidence) return false;
  for (const nf of f.numeric) {
    const v = Number((ev as unknown as Record<string, unknown>)[nf.key] ?? 0);
    if (nf.op === ">=" ? v < nf.value : v > nf.value) return false;
  }
  const q = f.search.trim().toLowerCase();
  if (q && !`${ev.iteration_id}\n${ev.strategy}`.toLowerCase().includes(q)) return false;
  return true;
}

/** A short "Failed · Timeout" summary of the active Timeline filters. */
export function timelineFilterChips(f: TimelineFilters): string[] {
  const chips: string[] = [];
  if (f.status !== "ALL") chips.push(OUTCOME_LABEL[f.status]);
  if (f.retried) chips.push("Retried");
  if (f.category !== "ALL") chips.push(categoryLabel(f.category));
  if (f.decision !== "ALL") chips.push(`Decision: ${f.decision}`);
  if (f.search.trim()) chips.push(`“${f.search.trim()}”`);
  return chips;
}

export function evaluationFilterChips(f: EvaluationFilters): string[] {
  const chips: string[] = [];
  if (f.status !== "ALL") chips.push(f.status === "RETRY" ? "Retry" : f.status.replace(/_/g, " ").toLowerCase());
  if (f.confidence !== "ALL") chips.push(`${f.confidence} confidence`);
  for (const nf of f.numeric) chips.push(`${DIMENSION_LABEL[nf.key] ?? nf.key} ${nf.op} ${nf.value}`);
  if (f.search.trim()) chips.push(`“${f.search.trim()}”`);
  return chips;
}

/* ── shared vocabulary for the toolbars ────────────────────────────────────── */

/** The ten dimension keys and labels (mirrors the Evaluator panel). */
export const DIMENSION_LABEL: Record<string, string> = {
  result_quality: "Result quality",
  evidence_quality: "Evidence quality",
  source_quality: "Source quality",
  relevance: "Relevance",
  completeness: "Completeness",
  novelty: "Novelty",
  knowledge_gain: "Knowledge gain",
  uncertainty_reduction: "Uncertainty cut",
  objective_progress: "Objective progress",
  confidence: "Confidence",
};

export const NUMERIC_DIMENSIONS = Object.keys(DIMENSION_LABEL);

/** The iteration-level decision vocabulary (mirrors `research/models.py` ACTION_*). */
export const DECISIONS = ["CONTINUE", "BRANCH", "RETRY", "WAIT", "STOP"] as const;

/** Distinct categories present in a dataset, discovery-first. */
export function presentCategories(iterations: Iteration[]): string[] {
  const set = new Set<string>();
  for (const it of iterations) if (it.strategy) set.add(it.strategy);
  return [...set].sort();
}

/** Distinct decisions present in a dataset, in engine order. */
export function presentDecisions(iterations: Iteration[]): string[] {
  const seen = new Set<string>();
  for (const it of iterations) if (it.next_action) seen.add(it.next_action);
  return DECISIONS.filter((d) => seen.has(d));
}
