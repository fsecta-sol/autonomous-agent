/**
 * The Scheduler API surface — the single seam between the Scheduler UI and the
 * backend's `/api/scheduler/*` proxy (which forwards to the agent's durable
 * temporal execution layer). Components never call `fetch` for it directly.
 *
 * Typed against the agent's own wire shapes (`research/scheduler/model.py`
 * `summary()`/`to_dict()`), so a field rename on the engine surfaces here as a
 * compile error rather than a silently blank panel.
 */

/** `SCHEDULE_TYPES` — how a schedule decides WHEN to fire. */
export type ScheduleType =
  | "IMMEDIATE"
  | "ONCE"
  | "DELAYED"
  | "RECURRING"
  | "CRON"
  | "INTERVAL"
  | "EVENT"
  | "DEPENDENCY";

/** `SCHEDULE_STATUSES`. */
export type ScheduleStatus = "ACTIVE" | "PAUSED" | "COMPLETED" | "CANCELLED" | "FAILED";

/** `JOB_STATUSES` — the explicit state machine of one execution instance. */
export type JobStatus =
  | "SCHEDULED"
  | "READY"
  | "QUEUED"
  | "RUNNING"
  | "CHECKPOINTING"
  | "WAITING"
  | "RETRYING"
  | "PAUSED"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "EXPIRED"
  | "DEAD_LETTER";

export type Priority = "CRITICAL" | "HIGH" | "NORMAL" | "LOW";

/** A schedule's retry policy (`RetryPolicy.to_dict()`). */
export interface RetryPolicyData {
  max_attempts: number;
  strategy: string;
  base_delay_ms: number;
  max_delay_ms: number;
  jitter: number;
}

export interface ConcurrencyPolicyData {
  mode: string;
  max_instances: number;
}

/** `Schedule.summary()` — WHEN a research run should execute. */
export interface ScheduleSummary {
  id: string;
  researchRunId: string;
  type: ScheduleType;
  status: ScheduleStatus;
  priority: Priority;
  cron: string;
  intervalS: number;
  at: number | null;
  delayS: number;
  event: string;
  dependsOn: string[];
  depCondition: string;
  timezone: string;
  nextRunAt: number | null;
  lastRunAt: number | null;
  runCount: number;
  maxRuns: number | null;
  retry: RetryPolicyData;
  concurrency: ConcurrencyPolicyData;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

/** `ScheduledJob.summary()` — one execution instance of a schedule. */
export interface JobSummary {
  id: string;
  scheduleId: string;
  researchRunId: string;
  status: JobStatus;
  priority: Priority;
  scheduledAt: number;
  readyAt: number | null;
  startedAt: number | null;
  completedAt: number | null;
  attempt: number;
  maxAttempts: number;
  workerId: string;
  leaseId: string;
  idempotencyKey: string;
  dependencyIds: string[];
  lastError: { class?: string; kind?: string; message?: string; retryable?: boolean };
  decision: string;
  decisionReasons: string[];
  waitReason: string;
  checkpointIteration: number | null;
  replayOf: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

/** One upcoming firing (`debug_view().upcoming[]`). */
export interface Upcoming {
  scheduleId: string;
  runId: string;
  nextRunAt: number;
  type: ScheduleType;
}

/** `debug_view()` — the scheduler's own observability payload. */
export interface SchedulerDebug {
  workers: Record<string, unknown>;
  queue: Record<string, number>;
  upcoming: Upcoming[];
  running: JobSummary[];
  waiting: JobSummary[];
  retrying: JobSummary[];
  deadLetter: JobSummary[];
  resources: Record<string, unknown>;
  metrics: Record<string, unknown>;
}

/** The scheduler's pluggable registers (GET `/api/scheduler` → `registries`). */
export interface SchedulerRegistries {
  scheduleTypes?: ScheduleType[];
  jobStatuses?: JobStatus[];
  priorities?: Priority[];
  triggers?: string[];
  policies?: string[];
  retryStrategies?: string[];
  recoveryPolicies?: string[];
}

/** The merged overview the backend assembles from the agent's scheduler. */
export interface SchedulerOverview {
  enabled: boolean;
  debug: SchedulerDebug | null;
  schedules: ScheduleSummary[];
  jobs: JobSummary[];
  registries: SchedulerRegistries;
}

export class SchedulerApiError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.name = "SchedulerApiError";
    this.status = status;
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new SchedulerApiError(`Network error: ${String(err)}`, null);
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* empty / non-JSON body */
  }
  if (!res.ok) {
    const obj = (body ?? {}) as { error?: string; detail?: string };
    throw new SchedulerApiError(obj.error || obj.detail || `Request failed with HTTP ${res.status}`, res.status);
  }
  const obj = (body ?? {}) as { error?: string };
  if (obj.error) throw new SchedulerApiError(obj.error, res.status);
  return body as T;
}

/** The full scheduler overview (disabled state included). */
export async function getOverview(): Promise<SchedulerOverview> {
  return request<SchedulerOverview>("/api/scheduler");
}

export interface CreateScheduleInput {
  researchRunId: string;
  type: ScheduleType;
  priority?: Priority;
  cron?: string;
  intervalS?: number;
  delayS?: number;
  at?: string;
  event?: string;
  timezone?: string;
  maxRuns?: number;
  dependsOn?: string[];
}

/** Create a schedule for an existing research run. */
export async function createSchedule(input: CreateScheduleInput): Promise<{ schedule: ScheduleSummary }> {
  return request<{ schedule: ScheduleSummary }>("/api/scheduler", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

/** Schedule verbs (POST `/api/scheduler/schedules/{id}/{action}`). */
export type ScheduleAction = "pause" | "resume" | "cancel";
/** Job verbs (POST `/api/scheduler/jobs/{id}/{action}`). */
export type JobAction = "pause" | "resume" | "cancel" | "trigger" | "replay";

export async function scheduleAction(id: string, action: ScheduleAction): Promise<{ schedule: ScheduleSummary }> {
  return request(`/api/scheduler/schedules/${encodeURIComponent(id)}/${action}`, { method: "POST" });
}

export async function jobAction(id: string, action: JobAction): Promise<{ job: JobSummary }> {
  return request(`/api/scheduler/jobs/${encodeURIComponent(id)}/${action}`, { method: "POST" });
}

/** Human description of when a schedule fires, from its real spec fields. */
export function scheduleWhen(s: ScheduleSummary): string {
  switch (s.type) {
    case "IMMEDIATE":
      return "Immediately, once";
    case "ONCE":
      return s.at ? `Once at ${new Date(s.at).toLocaleString()}` : "Once (no time set)";
    case "DELAYED":
      return s.delayS ? `In ${s.delayS}s` : "After a delay";
    case "CRON":
      return s.cron ? `Cron ${s.cron}` : "Cron (unspecified)";
    case "INTERVAL":
      return s.intervalS ? `Every ${humanInterval(s.intervalS)}` : "On an interval";
    case "EVENT":
      return s.event ? `On event "${s.event}"` : "On an event";
    case "DEPENDENCY":
      return s.dependsOn.length ? `After ${s.dependsOn.length} job(s)` : "After dependencies";
    case "RECURRING":
      return "Recurring";
    default:
      return s.type;
  }
}

function humanInterval(s: number): string {
  if (s % 86400 === 0) return `${s / 86400}d`;
  if (s % 3600 === 0) return `${s / 3600}h`;
  if (s % 60 === 0) return `${s / 60}m`;
  return `${s}s`;
}

/** The statuses that mean nothing further happens without operator action. */
export const TERMINAL_JOB_STATUSES: ReadonlySet<JobStatus> = new Set([
  "COMPLETED",
  "CANCELLED",
  "EXPIRED",
  "DEAD_LETTER",
]);

export function isTerminalJob(status: JobStatus): boolean {
  return TERMINAL_JOB_STATUSES.has(status);
}
