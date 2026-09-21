"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getOverview,
  scheduleAction,
  jobAction,
  scheduleWhen,
  isTerminalJob,
  SchedulerApiError,
  type JobSummary,
  type ScheduleSummary,
  type SchedulerDebug,
  type SchedulerOverview,
} from "@/lib/scheduler";
import { useWorkspace } from "@/components/providers/workspace";
import { clock, formatDuration, relativeTime, StateNote } from "@/components/research/shared";

type Tone = "run" | "wait" | "ok" | "stop" | "err";

/** A job status → badge tone. */
function jobTone(status: JobSummary["status"]): Tone {
  switch (status) {
    case "RUNNING":
    case "CHECKPOINTING":
      return "run";
    case "COMPLETED":
      return "ok";
    case "FAILED":
    case "DEAD_LETTER":
      return "err";
    case "CANCELLED":
    case "EXPIRED":
      return "stop";
    default:
      return "wait"; // SCHEDULED | READY | QUEUED | WAITING | RETRYING | PAUSED
  }
}

function schedTone(status: ScheduleSummary["status"]): Tone {
  switch (status) {
    case "ACTIVE":
      return "run";
    case "COMPLETED":
      return "ok";
    case "FAILED":
      return "err";
    case "CANCELLED":
      return "stop";
    default:
      return "wait"; // PAUSED
  }
}

/**
 * The Scheduler — the operator's view of the agent's durable temporal execution
 * layer: what will run next, what is running now, and what already ran. Every
 * value comes from the agent's scheduler debug/metrics/registries; nothing is
 * synthesized. When the scheduler is disabled agent-side the view says so.
 */
export function SchedulerView() {
  const { openRunInResearch } = useWorkspace();
  const [data, setData] = useState<SchedulerOverview | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
  // Sampled on each poll (outside render) so a running job's live duration ticks
  // with the 5s refresh rather than calling Date.now() during render.
  const [now, setNow] = useState(0);

  const load = useCallback(async () => {
    try {
      const d = await getOverview();
      setData(d);
      setNow(Date.now());
      setState("ready");
      setError("");
    } catch (err) {
      setState("error");
      setError(err instanceof SchedulerApiError ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await load();
    })();
    // The scheduler moves on its own schedule — poll while the view is open.
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load]);

  const act = useCallback(
    async (kind: "schedules" | "jobs", id: string, action: string) => {
      setPending(`${kind}:${id}:${action}`);
      setActionError("");
      try {
        if (kind === "schedules") {
          await scheduleAction(id, action as Parameters<typeof scheduleAction>[1]);
        } else {
          await jobAction(id, action as Parameters<typeof jobAction>[1]);
        }
        await load();
      } catch (err) {
        setActionError(err instanceof SchedulerApiError ? err.message : String(err));
      } finally {
        setPending(null);
      }
    },
    [load],
  );

  if (state === "loading" && !data) {
    return (
      <section className="view active" data-od-id="view-scheduler">
        <StateNote kind="loading" title="Loading scheduler…" />
      </section>
    );
  }
  if (state === "error" && !data) {
    return (
      <section className="view active" data-od-id="view-scheduler">
        <StateNote kind="error" title="Unable to load the scheduler." detail={error} onRetry={() => void load()} />
      </section>
    );
  }
  if (data && !data.enabled) {
    return (
      <section className="view active" data-od-id="view-scheduler">
        <Header />
        <StateNote
          kind="info"
          title="Scheduler is disabled on the agent."
          detail="Set AGENT_SCHEDULER_ENABLED=1 on the agent service to enable durable scheduled execution."
        />
      </section>
    );
  }
  if (!data) return null;

  return (
    <section className="view active sched-view" data-od-id="view-scheduler">
      <Header error={actionError} onRefresh={() => void load()} />
      <div className="sched-scroll">
        <Metrics debug={data.debug} registries={data.registries} />

        <div className="sched-cols">
          <Upcoming upcoming={data.debug?.upcoming ?? []} />
          <Workers workers={data.debug?.workers} resources={data.debug?.resources} />
        </div>

        <Schedules
          schedules={data.schedules}
          pending={pending}
          onAct={(id, a) => void act("schedules", id, a)}
          onOpenRun={openRunInResearch}
        />

        <Jobs
          jobs={data.jobs}
          debug={data.debug}
          pending={pending}
          now={now}
          onAct={(id, a) => void act("jobs", id, a)}
          onOpenRun={openRunInResearch}
        />
      </div>
    </section>
  );
}

function Header({ error, onRefresh }: { error?: string; onRefresh?: () => void }) {
  return (
    <header className="sched-head">
      <div className="sched-head-main">
        <h1 className="sched-title">Scheduler</h1>
        <p className="sched-sub">
          The agent’s durable temporal execution layer — what will run next, what is running, and what has run.
        </p>
      </div>
      {onRefresh ? (
        <button type="button" className="rl-btn" onClick={onRefresh}>
          Refresh
        </button>
      ) : null}
      {error ? <div className="sched-action-error">{error}</div> : null}
    </header>
  );
}

/* ── metrics strip ──────────────────────────────────────────────────────── */

const METRIC_KEYS: Array<{ key: string; label: string }> = [
  { key: "jobsScheduled", label: "Scheduled" },
  { key: "jobsCompleted", label: "Completed" },
  { key: "jobsFailed", label: "Failed" },
  { key: "jobsRetried", label: "Retried" },
  { key: "jobsDeadLettered", label: "Dead-lettered" },
  { key: "jobsRecovered", label: "Recovered" },
  { key: "circuitBreaks", label: "Circuit breaks" },
  { key: "leaseExpirations", label: "Lease expiries" },
];

function Metrics({
  debug,
  registries,
}: {
  debug: SchedulerOverview["debug"];
  registries: SchedulerOverview["registries"];
}) {
  const m = (debug?.metrics ?? {}) as Record<string, unknown>;
  const num = (k: string) => (typeof m[k] === "number" ? (m[k] as number) : 0);
  const queue = (debug?.queue ?? {}) as Record<string, number>;
  const workers =
    typeof m.workers === "object" && m.workers
      ? (m.workers as { active?: number; capacity?: number })
      : {};
  const queueTotal = Object.values(queue).reduce((a, b) => a + b, 0);

  return (
    <section className="sched-metrics" aria-label="Scheduler metrics">
      <div className="sched-metric is-hero">
        <div className="sched-metric-k">Queue depth</div>
        <div className="sched-metric-v">{queueTotal}</div>
      </div>
      <div className="sched-metric is-hero">
        <div className="sched-metric-k">Workers</div>
        <div className="sched-metric-v">
          {workers.active ?? "—"}
          <span className="sched-metric-unit">/ {workers.capacity ?? "—"}</span>
        </div>
      </div>
      {METRIC_KEYS.map((k) => (
        <div className="sched-metric" key={k.key}>
          <div className="sched-metric-k">{k.label}</div>
          <div className="sched-metric-v">{num(k.key)}</div>
        </div>
      ))}
      <div className="sched-metric">
        <div className="sched-metric-k">Avg run</div>
        <div className="sched-metric-v">
          {num("avgExecutionMs") ? formatDuration(num("avgExecutionMs") / 1000) : "—"}
        </div>
      </div>
      <div className="sched-metric">
        <div className="sched-metric-k">Avg queue wait</div>
        <div className="sched-metric-v">
          {num("avgQueueLatencyMs") ? formatDuration(num("avgQueueLatencyMs") / 1000) : "—"}
        </div>
      </div>
      {registries.scheduleTypes?.length ? (
        <div className="sched-metric is-wide">
          <div className="sched-metric-k">Trigger types</div>
          <div className="sched-regs">
            {registries.scheduleTypes.map((t) => (
              <span className="sched-reg" key={t}>
                {t}
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

/* ── upcoming + workers ─────────────────────────────────────────────────── */

function Upcoming({ upcoming }: { upcoming: SchedulerDebug["upcoming"] }) {
  return (
    <section className="sched-panel" aria-label="Upcoming firings">
      <h2 className="sched-panel-title">
        Upcoming <span className="sched-count">{upcoming.length}</span>
      </h2>
      {!upcoming.length ? (
        <div className="sched-empty">No scheduled firings ahead.</div>
      ) : (
        <ol className="sched-upcoming">
          {upcoming.map((u) => (
            <li className="sched-up-item" key={`${u.scheduleId}-${u.nextRunAt}`}>
              <span className="sched-up-when rl-mono" title={new Date(u.nextRunAt).toLocaleString()}>
                {relativeTime(u.nextRunAt)}
              </span>
              <span className="sched-up-type rl-mono">{u.type}</span>
              <span className="sched-up-run rl-mono" title={u.runId}>
                {shortId(u.runId)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function Workers({
  workers,
  resources,
}: {
  workers: SchedulerDebug["workers"] | undefined;
  resources: SchedulerDebug["resources"] | undefined;
}) {
  const list = Array.isArray(workers) ? (workers as Array<Record<string, unknown>>) : [];
  const res = (resources ?? {}) as Record<string, unknown>;
  const globalActive = typeof res.globalActive === "number" ? res.globalActive : null;
  const maxRuns = typeof res.maxConcurrentRuns === "number" ? res.maxConcurrentRuns : null;

  return (
    <section className="sched-panel" aria-label="Workers">
      <h2 className="sched-panel-title">
        Workers <span className="sched-count">{list.length}</span>
        {maxRuns != null ? (
          <span className="sched-panel-note rl-mono">
            concurrent runs {globalActive ?? 0}/{maxRuns}
          </span>
        ) : null}
      </h2>
      {!list.length ? (
        <div className="sched-empty">No workers registered.</div>
      ) : (
        <ul className="sched-workers">
          {list.map((w) => {
            const status = String(w.status ?? "");
            const active = Number(w.active ?? 0);
            const max = Number(w.maxConcurrency ?? 0);
            return (
              <li className="sched-worker" key={String(w.id)}>
                <span className="sched-worker-dot" data-tone={status === "RUNNING" || status === "ACTIVE" ? "run" : "wait"} aria-hidden />
                <span className="sched-worker-id rl-mono" title={String(w.id)}>
                  {String(w.id)}
                </span>
                <span className="sched-worker-status rl-mono">{status}</span>
                <span className="sched-worker-load rl-mono">
                  {active}/{max}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/* ── schedules ──────────────────────────────────────────────────────────── */

function Schedules({
  schedules,
  pending,
  onAct,
  onOpenRun,
}: {
  schedules: ScheduleSummary[];
  pending: string | null;
  onAct: (id: string, action: string) => void;
  onOpenRun: (runId: string) => void;
}) {
  return (
    <section className="sched-panel sched-panel-full" aria-label="Schedules">
      <h2 className="sched-panel-title">
        Schedules <span className="sched-count">{schedules.length}</span>
      </h2>
      {!schedules.length ? (
        <div className="sched-empty">No schedules. A schedule is created from a research run.</div>
      ) : (
        <div className="sched-schedules">
          {schedules.map((s) => (
            <div className="sched-sch" key={s.id}>
              <div className="sched-sch-main">
                <span className="sched-badge" data-tone={schedTone(s.status)}>
                  {s.status}
                </span>
                <span className="sched-sch-when">{scheduleWhen(s)}</span>
                <span className="sched-sch-prio rl-mono" data-prio={s.priority}>
                  {s.priority}
                </span>
              </div>
              <div className="sched-sch-meta">
                <button type="button" className="sched-run-link rl-mono" onClick={() => onOpenRun(s.researchRunId)}>
                  run {shortId(s.researchRunId)}
                </button>
                <span className="rl-mono">
                  runs {s.runCount}
                  {s.maxRuns != null ? `/${s.maxRuns}` : ""}
                </span>
                {s.nextRunAt ? <span className="rl-mono">next {relativeTime(s.nextRunAt)}</span> : null}
                {s.lastRunAt ? <span className="rl-mono">last {relativeTime(s.lastRunAt)}</span> : null}
                <span className="rl-mono">{s.timezone}</span>
              </div>
              <div className="sched-sch-actions">
                {s.status === "ACTIVE" ? (
                  <button
                    type="button"
                    className="rl-btn"
                    disabled={pending === `schedules:${s.id}:pause`}
                    onClick={() => onAct(s.id, "pause")}
                  >
                    Pause
                  </button>
                ) : s.status === "PAUSED" ? (
                  <button
                    type="button"
                    className="rl-btn"
                    disabled={pending === `schedules:${s.id}:resume`}
                    onClick={() => onAct(s.id, "resume")}
                  >
                    Resume
                  </button>
                ) : null}
                {s.status !== "CANCELLED" && s.status !== "COMPLETED" ? (
                  <button
                    type="button"
                    className="rl-btn"
                    disabled={pending === `schedules:${s.id}:cancel`}
                    onClick={() => onAct(s.id, "cancel")}
                  >
                    Cancel
                  </button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/* ── jobs ───────────────────────────────────────────────────────────────── */

function Jobs({
  jobs,
  debug,
  pending,
  now,
  onAct,
  onOpenRun,
}: {
  jobs: JobSummary[];
  debug: SchedulerOverview["debug"];
  pending: string | null;
  now: number;
  onAct: (id: string, action: string) => void;
  onOpenRun: (runId: string) => void;
}) {
  // Active work first (running/waiting/retrying), then recent terminal history.
  const active = useMemo(
    () => jobs.filter((j) => !isTerminalJob(j.status)).sort((a, b) => b.updatedAt - a.updatedAt),
    [jobs],
  );
  const history = useMemo(
    () => jobs.filter((j) => isTerminalJob(j.status)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 30),
    [jobs],
  );
  const dlq = debug?.deadLetter ?? [];

  return (
    <section className="sched-panel sched-panel-full" aria-label="Jobs">
      <h2 className="sched-panel-title">
        Jobs <span className="sched-count">{jobs.length}</span>
        {active.length ? <span className="sched-panel-note">{active.length} active</span> : null}
      </h2>

      {dlq.length ? (
        <div className="sched-dlq">
          <span className="sched-dlq-label">Dead-letter</span>
          <span className="rl-mono">{dlq.length}</span>
        </div>
      ) : null}

      {!jobs.length ? (
        <div className="sched-empty">No jobs yet.</div>
      ) : (
        <>
          <div className="sched-jobs">
            {active.map((j) => (
              <JobRow key={j.id} j={j} pending={pending} now={now} onAct={onAct} onOpenRun={onOpenRun} />
            ))}
          </div>
          {history.length ? (
            <>
              <h3 className="sched-subhead">Recent</h3>
              <div className="sched-jobs">
                {history.map((j) => (
                  <JobRow key={j.id} j={j} pending={pending} now={now} onAct={onAct} onOpenRun={onOpenRun} />
                ))}
              </div>
            </>
          ) : null}
        </>
      )}
    </section>
  );
}

function JobRow({
  j,
  pending,
  now,
  onAct,
  onOpenRun,
}: {
  j: JobSummary;
  pending: string | null;
  now: number;
  onAct: (id: string, action: string) => void;
  onOpenRun: (runId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const busy = pending?.startsWith(`jobs:${j.id}:`);
  const duration =
    j.startedAt && j.completedAt
      ? formatDuration((j.completedAt - j.startedAt) / 1000)
      : j.startedAt
        ? `${formatDuration((now - j.startedAt) / 1000)} (running)`
        : "—";
  const why = j.waitReason || j.lastError?.message || j.decisionReasons?.[0] || "";

  return (
    <div className={`sched-job ${open ? "is-open" : ""}`}>
      <button type="button" className="sched-job-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="sched-badge" data-tone={jobTone(j.status)}>
          {j.status}
        </span>
        <button
          type="button"
          className="sched-run-link rl-mono"
          onClick={(e) => {
            e.stopPropagation();
            onOpenRun(j.researchRunId);
          }}
        >
          run {shortId(j.researchRunId)}
        </button>
        <span className="sched-job-prio rl-mono" data-prio={j.priority}>
          {j.priority}
        </span>
        <span className="sched-job-att rl-mono">
          try {j.attempt + 1}/{j.maxAttempts}
        </span>
        {why ? <span className="sched-job-why" title={why}>{why}</span> : null}
        <span className="sched-job-dur rl-mono">{duration}</span>
        <span className="sched-job-time rl-mono">{clock(j.scheduledAt)}</span>
      </button>

      {open ? (
        <div className="sched-job-body">
          <div className="sched-kv">
            <div>
              <span className="rl-mono">job</span> {j.id}
            </div>
            <div>
              <span className="rl-mono">schedule</span> {j.scheduleId}
            </div>
            <div>
              <span className="rl-mono">worker</span> {j.workerId || "—"}
            </div>
            <div>
              <span className="rl-mono">decision</span> {j.decision || "—"}
            </div>
            {j.checkpointIteration != null ? (
              <div>
                <span className="rl-mono">checkpoint</span> iteration {j.checkpointIteration}
              </div>
            ) : null}
            {j.replayOf ? (
              <div>
                <span className="rl-mono">replay of</span> {j.replayOf}
              </div>
            ) : null}
          </div>
          {j.decisionReasons?.length ? (
            <ul className="sched-reasons">
              {j.decisionReasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          ) : null}
          {j.lastError?.message ? (
            <div className="sched-job-error">
              <span className="rl-mono">{j.lastError.class || "error"}</span> {j.lastError.message}
            </div>
          ) : null}
          <div className="sched-job-actions">
            {j.status === "PAUSED" ? (
              <button type="button" className="rl-btn" disabled={busy} onClick={() => onAct(j.id, "resume")}>
                Resume
              </button>
            ) : !isTerminalJob(j.status) ? (
              <button type="button" className="rl-btn" disabled={busy} onClick={() => onAct(j.id, "pause")}>
                Pause
              </button>
            ) : null}
            {!isTerminalJob(j.status) ? (
              <button type="button" className="rl-btn" disabled={busy} onClick={() => onAct(j.id, "cancel")}>
                Cancel
              </button>
            ) : null}
            {isTerminalJob(j.status) ? (
              <button type="button" className="rl-btn" disabled={busy} onClick={() => onAct(j.id, "replay")}>
                Replay
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function shortId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}
