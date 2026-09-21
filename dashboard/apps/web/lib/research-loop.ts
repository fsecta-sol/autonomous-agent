/**
 * The Research Loop API surface — the single seam between the Research UI and
 * the backend's `/api/research/*` proxy (which forwards to the agent service,
 * which owns the loop). Components never call `fetch` for research directly.
 *
 * Everything here is typed against the agent's own wire shapes (`research/models.py`
 * `summary()`/`to_dict()` and the `/research/*` routes in `agent/main.py`), so a
 * field rename on the engine shows up here as a type error rather than a blank panel.
 */

/** A run's lifecycle status. Mirrors `research.models.RUN_STATUSES`. */
export type RunStatus =
  | "PENDING"
  | "RUNNING"
  | "PAUSED"
  | "WAITING"
  | "BLOCKED"
  | "COMPLETED"
  | "CANCELLED"
  | "FAILED";

/** A run's live stage. Mirrors `research.models.STAGES`. */
export type RunStage =
  | "IDLE"
  | "LOADING_CONTEXT"
  | "ANALYZING_KNOWLEDGE"
  | "GENERATING_CANDIDATES"
  | "PRIORITIZING"
  | "PLANNING"
  | "EXECUTING"
  | "COLLECTING_EVIDENCE"
  | "ANALYZING_RESULT"
  | "UPDATING_KNOWLEDGE"
  | "EVALUATING_PROGRESS"
  | "DECIDING_NEXT_ACTION"
  | "WAITING"
  | "DONE";

export interface RunBudget {
  max_iterations: number | null;
  max_tool_calls: number | null;
  max_tokens: number | null;
  max_wall_clock_s: number | null;
}

/** Cumulative, information-gain-oriented progress (`research.models.Progress`). */
export interface RunProgress {
  iterations: number;
  knowledge_created: number;
  knowledge_updated: number;
  unknowns_created: number;
  unknowns_resolved: number;
  conflicts_found: number;
  relationships_added: number;
  evidence_items: number;
  hypotheses_rejected: number;
  low_value_streak: number;
  info_gain: number;
}

/** A run as the list/detail endpoints summarise it (`ResearchRun.summary()`). */
export interface RunSummary {
  id: string;
  objective: string;
  success_criteria: string[];
  status: RunStatus;
  stage: RunStage;
  iteration: number;
  startedAt: number;
  updatedAt: number;
  completedAt: number | null;
  elapsedS: number;
  budget: RunBudget;
  progress: RunProgress;
  terminationReason: string;
  parentRunId: string | null;
  currentIterationId: string | null;
  currentCandidateId: string | null;
}

/** One loop cycle (`ResearchIteration.to_dict()`). */
export interface Iteration {
  id: string;
  run_id: string;
  index: number;
  hypothesis: string;
  branch: string;
  candidate_id: string | null;
  plan_id: string | null;
  result_id: string | null;
  strategy: string;
  stage: string;
  disposition: string;
  knowledge_updates: KnowledgeUpdate[];
  evaluation: Evaluation | Record<string, never>;
  next_action: string;
  next_reason: string;
  started_at: number;
  updated_at: number;
  finished_at: number | null;
}

/** The audit line the KnowledgeUpdater records per iteration (`updater.py`). */
export interface KnowledgeUpdate {
  op: string; // create | update | duplicate | conflict | supersede | verified | interpretation | unknown | error (lowercased)
  id?: string;
  question?: string;
  superseded?: string;
  status?: string;
}

export interface Evaluation {
  answered_question?: boolean;
  new_evidence?: boolean;
  knowledge_increased?: boolean;
  uncertainty_reduced?: boolean;
  new_unknowns?: number;
  contradiction_created?: boolean;
  hypothesis_survived?: boolean | null;
  failed?: boolean;
  failure_kind?: string;
  info_gain?: number;
  should_retry?: boolean;
  should_branch?: boolean;
  notes?: string[];
}

/** A proposed investigation (`ResearchCandidate.to_dict()`). */
export interface Candidate {
  id: string;
  question: string;
  reason: string;
  objective: string;
  expected_information_gain: string;
  priority_hint: string;
  dependencies: string[];
  estimated_cost: string;
  risk: string;
  related_knowledge: string[];
  related_unknowns: string[];
  related_conflicts: string[];
  branch: string;
  source_gap_kind: string;
  priority: number;
  rank_inputs: Record<string, number>;
  status: string;
  created_at: number;
}

/** A durable loop event (`ResearchEvent.to_dict()`). */
export interface ResearchEvent {
  id: string;
  run_id: string;
  type: string;
  iteration_index: number | null;
  data: Record<string, unknown>;
  ts: number;
}

/** One run's full state (GET `/api/research/runs/{id}`). */
export interface RunDetailData {
  run: RunSummary;
  iterations: Iteration[];
  /** The run's true iteration total. Set when it exceeds `iterations.length`
   * (the endpoint returns the oldest `iterations_limit` rows), so the UI can warn
   * that the timeline is partial rather than imply the run is complete. */
  iterationCount?: number;
  candidates: Candidate[];
  driving: boolean;
  branches: Record<string, unknown>;
}

/** The health report the Knowledge Manager emits (`validate_graph()`). */
export interface KnowledgeHealth {
  nodes: number;
  relationships: number;
  unverified: number;
  verified: number;
  conflicts: number;
  conflict_nodes: string[];
  open_unknowns: number;
  unknown_nodes: string[];
  broken_links: number;
  broken: Array<{ source: string; target: string }>;
  orphan_nodes: number;
  orphans: string[];
  missing_sources: number;
  missing_sources_nodes: string[];
  superseded: number;
  dangling_index: number;
}

/** The registries + vocabulary the UI renders the state machine from (GET `/meta`). */
export interface ResearchMeta {
  strategies: string[];
  prioritizers: string[];
  stop_conditions: string[];
  statuses: RunStatus[];
  stages: RunStage[];
  /** `validate_graph()` from the agent's Knowledge Manager */
  knowledge?: KnowledgeHealth;
}

/** A typed error surfaced by any research call — carries the HTTP status. */
export class ResearchApiError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.name = "ResearchApiError";
    this.status = status;
  }
}

/** Read a fetch response as JSON, turning a non-2xx into a typed error. */
async function readJson<T>(res: Response): Promise<T> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* empty / non-JSON body — fall through to the status-based message */
  }
  if (!res.ok) {
    const obj = (body ?? {}) as { error?: string; detail?: string };
    const msg = obj.error || obj.detail || `Request failed with HTTP ${res.status}`;
    throw new ResearchApiError(msg, res.status);
  }
  // The proxy answers 200 with `{error:"not found"}` for a missing run, so a
  // body-level error must still fail loudly rather than render as empty data.
  const obj = (body ?? {}) as { error?: string };
  if (obj.error) throw new ResearchApiError(obj.error, res.status);
  return body as T;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new ResearchApiError(`Network error: ${String(err)}`, null);
  }
  return readJson<T>(res);
}

/** List runs, newest first, optionally filtered by status. */
export async function listRuns(status?: RunStatus): Promise<{ runs: RunSummary[]; running: string[] }> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : "";
  return request<{ runs: RunSummary[]; running: string[] }>(`/api/research/runs${qs}`);
}

/** One run's full state: summary + iterations + candidates + branches.
 * `iterationsLimit` bounds a large run's iteration list (thousands of rows); the
 * response's `iterationCount` reports the true total. */
export async function getRun(id: string, iterationsLimit = 20000): Promise<RunDetailData> {
  return request<RunDetailData>(
    `/api/research/runs/${encodeURIComponent(id)}?iterations_limit=${iterationsLimit}`,
  );
}

/** The durable event log for a run (for the Events tab's initial load). */
export async function listEvents(id: string, since = 0): Promise<{ events: ResearchEvent[] }> {
  return request<{ events: ResearchEvent[] }>(
    `/api/research/runs/${encodeURIComponent(id)}/events?since=${since}`,
  );
}

/** The registries + status/stage vocabulary (and the knowledge health report). */
export async function getMeta(): Promise<ResearchMeta> {
  return request<ResearchMeta>("/api/research/meta");
}

/** Create a run. Only the fields the backend actually accepts are sent. */
export interface CreateRunInput {
  objective: string;
  successCriteria?: string[];
  domain?: string;
  agentId?: string;
  budget?: Partial<RunBudget>;
  /** loop overrides (`ResearchConfig.from_dict`) — e.g. max_iterations, stopping */
  researchConfig?: Record<string, unknown>;
}

export async function createRun(input: CreateRunInput): Promise<{ run: RunSummary; driving: boolean }> {
  return request<{ run: RunSummary; driving: boolean }>("/api/research/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      objective: input.objective,
      successCriteria: input.successCriteria ?? [],
      domain: input.domain ?? "",
      agentId: input.agentId ?? "",
      budget: input.budget,
      researchConfig: input.researchConfig,
      autostart: true,
    }),
  });
}

/** The lifecycle verbs the backend allow-lists (POST `/runs/{id}/{action}`). */
export type RunAction = "step" | "advance" | "pause" | "resume" | "cancel";

/**
 * Run one lifecycle action. The response shape varies by verb (`step` returns the
 * step; the rest return the run), so the caller reads the field it needs.
 */
export async function runAction(
  id: string,
  action: RunAction,
): Promise<{ run?: RunSummary; step?: Record<string, unknown>; driving?: boolean }> {
  return request(`/api/research/runs/${encodeURIComponent(id)}/${action}`, { method: "POST" });
}

/* ── Research Evaluator ───────────────────────────────────────────────────
 * The Evaluator's structured output, typed against `research/evaluator/model.py`
 * (raw snake_case rows — the list fields are JSON-decoded by the store before
 * they reach the API). An evaluation is a decision-support record, not a score.
 */

/** `EVAL_STATUSES` — the verdict of one iteration. */
export type EvalStatus = "SUCCESS" | "PARTIAL_SUCCESS" | "NO_PROGRESS" | "FAILED" | "BLOCKED";

/** `EVIDENCE_LEVELS` — what kind of claim a piece of output is. */
export type EvidenceLevel = "OBSERVATION" | "INTERPRETATION" | "INFERENCE" | "CONCLUSION" | "UNSUPPORTED";

/** `STRENGTH_ORDER` keys — how well supported a claim is. */
export type EvidenceStrength =
  | "CORROBORATED"
  | "DIRECT"
  | "INDIRECT"
  | "WEAK"
  | "UNSUPPORTED"
  | "CONTRADICTED";

export interface EvidenceAssessment {
  evidence_id: string;
  statement: string;
  kind: string;
  level: EvidenceLevel;
  strength: EvidenceStrength;
  value: number;
  source: string;
  corroborated_by: string[];
  rationale: string;
}

export interface EvaluationContradiction {
  id: string;
  subject: string;
  claim: string;
  conflicts_with: string;
  severity: "low" | "medium" | "high";
  evidence: string[];
  resolved: boolean;
  rationale: string;
}

export interface EvaluationDiscovery {
  id: string;
  statement: string;
  kind: string; // fact | relationship | unknown | hypothesis | capability
  confidence: number;
  related_knowledge: string[];
}

export interface EvaluationUnknown {
  id: string;
  question: string;
  severity: string;
  source: string; // uncertainty | gap | conflict
}

export interface EvaluationFailure {
  kind: string;
  reason: string;
  strategy: string;
  retryable: boolean;
  attempts: number;
}

export interface EvaluationSignal {
  name: string;
  direction: "positive" | "negative" | "neutral";
  weight: number;
  reason: string;
}

export interface DimensionScore {
  name: string;
  score: number;
  weight: number;
  rationale: string;
}

export interface Recommendation {
  action: string;
  reason: string;
  suggested_strategy: string;
  suggested_focus: string;
  confidence: number;
  signals: string[];
}

export interface EvaluationReasoning {
  summary: string;
  steps: string[];
  dimensions: DimensionScore[];
  notes: string[];
}

/** One evaluation (`ResearchEvaluation` as the store returns it). */
export interface ResearchEvaluation {
  id: string;
  research_run_id: string;
  iteration_id: string;
  status: EvalStatus;
  result_quality: number;
  evidence_quality: number;
  source_quality: number;
  relevance: number;
  completeness: number;
  novelty: number;
  knowledge_gain: number;
  uncertainty_reduction: number;
  objective_progress: number;
  confidence: number;
  answered_questions: string[];
  unanswered_questions: string[];
  new_knowledge_ids: string[];
  updated_knowledge_ids: string[];
  contradictions: EvaluationContradiction[];
  discoveries: EvaluationDiscovery[];
  unresolved_unknowns: EvaluationUnknown[];
  redundant_with: string[];
  failures: EvaluationFailure[];
  evidence_assessments: EvidenceAssessment[];
  signals: EvaluationSignal[];
  recommendation: Recommendation | Record<string, never>;
  reasoning: EvaluationReasoning | Record<string, never>;
  strategy: string;
  scored_by: string[];
  llm_assisted: boolean;
  created_at: number;
}

/** The evaluator's registers + vocabulary (GET `/api/research/evaluators`). */
export interface EvaluatorMeta {
  evaluators: string[];
  dimensions: string[];
  recommenders: string[];
  statuses: EvalStatus[];
  evidenceLevels: EvidenceLevel[];
  evidenceStrengths: EvidenceStrength[];
  signals: string[];
}

/**
 * An evaluation as the *lean* list returns it: every scalar dimension plus the
 * small structured fields, with the three heavy arrays (`evidence_assessments`,
 * `unresolved_unknowns`, `reasoning`) collapsed to counts. Enough to filter,
 * score and chart every evaluation of a large run; the full record (with the
 * heavy arrays) is fetched one at a time via `getEvaluation`.
 */
export interface ResearchEvaluationLean {
  id: string;
  research_run_id: string;
  iteration_id: string;
  status: EvalStatus;
  strategy: string;
  llm_assisted: boolean;
  created_at: number;
  result_quality: number;
  evidence_quality: number;
  source_quality: number;
  relevance: number;
  completeness: number;
  novelty: number;
  knowledge_gain: number;
  uncertainty_reduction: number;
  objective_progress: number;
  confidence: number;
  signals: EvaluationSignal[];
  recommendation: Recommendation | Record<string, never>;
  failures: EvaluationFailure[];
  /** json_array_length() counts from the store */
  n_evidence: number;
  n_contradictions: number;
  n_discoveries: number;
  n_unknowns: number;
  n_answered: number;
  n_unanswered: number;
  n_scored_by: number;
}

/** The Evaluator's records for a run, one per iteration (oldest first).
 * `lean` collapses the heavy arrays so a large run loads in one response. */
export async function listEvaluations(
  id: string,
  limit = 500,
  lean = false,
): Promise<{ evaluations: ResearchEvaluation[] }> {
  return request<{ evaluations: ResearchEvaluation[] }>(
    `/api/research/runs/${encodeURIComponent(id)}/evaluations?limit=${limit}&lean=${lean ? "true" : "false"}`,
  );
}

/** The Evaluator's records collapsed to scalars + counts (see `ResearchEvaluationLean`). */
export async function listEvaluationsLean(
  id: string,
  limit = 20000,
): Promise<{ evaluations: ResearchEvaluationLean[] }> {
  return request<{ evaluations: ResearchEvaluationLean[] }>(
    `/api/research/runs/${encodeURIComponent(id)}/evaluations?limit=${limit}&lean=true`,
  );
}

/** One evaluation in full, including the heavy arrays the lean list omits. */
export async function getEvaluation(id: string): Promise<{ evaluation: ResearchEvaluation }> {
  return request<{ evaluation: ResearchEvaluation }>(
    `/api/research/evaluations/${encodeURIComponent(id)}`,
  );
}

/** The evaluator's dimension/evaluator/recommender registries + vocabulary. */
export async function getEvaluatorMeta(): Promise<EvaluatorMeta> {
  return request<EvaluatorMeta>("/api/research/evaluators");
}

/* ── executed results (the sub-agent's work) ────────────────────────────────
 * One per iteration: the evidence-first output plus the sub-agent's observable
 * activity trace. Typed against `research/models.py` `ResearchResult`
 * (raw snake_case rows; list fields JSON-decoded by the store).
 */

/** One step of the sub-agent's observable activity, in message order. */
export interface TraceStep {
  kind: "thought" | "tool_call" | "tool_result";
  /** thought / tool_result text (truncated engine-side) */
  text?: string;
  /** tool_call / tool_result: the tool name */
  name?: string;
  /** tool_call: the JSON-serialised arguments (truncated engine-side) */
  args?: string;
}

/** `ResearchResult` as the results endpoint returns it. */
export interface ResearchResult {
  id: string;
  run_id: string;
  candidate_id: string;
  iteration_id: string;
  strategy: string;
  question: string;
  observations: Array<{ statement?: string; source?: string }>;
  evidence: Array<{ kind?: string; statement?: string; source?: string }>;
  sources: string[];
  experiments: Array<Record<string, unknown>>;
  artifacts: string[];
  conclusions: string[];
  uncertainties: string[];
  hypothesis_survived: boolean | null;
  failure_kind: string;
  failure_reason: string;
  cost: { tool_calls?: number; tokens?: number; seconds?: number };
  trace: TraceStep[];
  created_at: number;
}

/** Each iteration's executed result and its activity trace, oldest first. */
/** Each iteration's executed result (sub-agent output + activity trace).
 * `limit` defaults high so the Timeline can pair every iteration of a large run
 * with its result rather than only the first few hundred. */
export async function listResults(id: string, limit = 20000): Promise<{ results: ResearchResult[] }> {
  return request<{ results: ResearchResult[] }>(
    `/api/research/runs/${encodeURIComponent(id)}/results?limit=${limit}`,
  );
}

/** Handlers for the live run event stream. */
export interface ResearchStreamHandlers {
  /** one event, whether replayed from the log or pushed live */
  onEvent: (event: ResearchEvent) => void;
  /** the stream ended (terminal event or server close) */
  onDone?: () => void;
  /** a transport error — the caller decides whether to reconnect */
  onError?: (err: unknown) => void;
  signal?: AbortSignal;
}

/**
 * Subscribe to a run's live SSE (`/api/research/runs/{id}/stream`). The agent
 * replays the durable log first, then follows live, so an attach sees history
 * and nothing is missed. Cleanup is the caller's: abort `signal` on unmount.
 */
export async function streamRun(id: string, handlers: ResearchStreamHandlers): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`/api/research/runs/${encodeURIComponent(id)}/stream`, {
      headers: { Accept: "text/event-stream" },
      signal: handlers.signal,
    });
  } catch (err) {
    if (isAbort(err)) return;
    handlers.onError?.(err);
    return;
  }
  if (!res.ok || !res.body) {
    handlers.onError?.(new ResearchApiError(`Stream failed with HTTP ${res.status}`, res.status));
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        for (const line of raw.split("\n")) {
          // SSE comment frames (keepalives) start with ":" — ignore them.
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          let frame: { research?: ResearchEvent; research_done?: boolean };
          try {
            frame = JSON.parse(payload) as { research?: ResearchEvent; research_done?: boolean };
          } catch {
            continue;
          }
          if (frame.research) handlers.onEvent(frame.research);
          if (frame.research_done) {
            handlers.onDone?.();
            return;
          }
        }
      }
    }
    handlers.onDone?.();
  } catch (err) {
    if (!isAbort(err)) handlers.onError?.(err);
  }
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}
