import type {
  Agent,
  AgentTelemetry,
  LatencyStats,
  SwarmTelemetry,
  TelemetryState,
} from "@dashboard/shared";
import { listAgents } from "@/lib/db/agents";
import { recentAssistantTurns, sessionAgentMap, type RecentTurn } from "@/lib/db/sessions";
import { getLastActivityAt, listActiveRuns } from "@/lib/server/runs";

/**
 * Runtime telemetry, derived — never invented.
 *
 * Every figure here is folded from state the backend already holds: the
 * in-process run registry (what is running right now), the persisted `messages`
 * table (what finished, when, and how long it took), and `process.uptime()`.
 * When a figure cannot be measured yet (`errorRate` with no history, `ttft`
 * with no timing) it is `null` and the UI reads "—", rather than a fake zero.
 *
 * The process that serves every request is a single Node process, so
 * `process.uptime()` and the run registry are the right scope — the same
 * reasoning as the in-memory Semaphore and run registry.
 */

/** The window over which rates are computed. Wider than the "recent" window a
 *  single screen shows, so throughput doesn't flicker between polls. */
const WINDOW_MS = 60 * 60 * 1000; // 1 hour
/** A run whose newest event is older than this reads stale, not working. */
const HEARTBEAT_STALE_MS = 45_000;

/**
 * Timing that a persisted turn's event log can honestly support.
 *
 * `total` is the span from the first recorded envelope to the last — a real
 * measure of how long the turn's recorded activity ran. `ttft` is only
 * meaningful when something other than a token came first (a tool call, say):
 * then `firstToken - first` is a genuine lead-in. A pure-text turn records its
 * first token as its first event, so "time to first token" is unmeasurable from
 * the log alone — we return `null` rather than a misleading 0. (The live TTFT,
 * measured client-side from send to first token, is the honest number there.)
 */
function latencyOf(events: unknown[] | null): { ttft: number | null; total: number | null } {
  if (!events?.length) return { ttft: null, total: null };
  let first = Infinity;
  let firstToken = Infinity;
  let last = -Infinity;
  for (const raw of events) {
    const e = raw as { type?: string; t?: number };
    if (typeof e.t !== "number") continue;
    if (e.t < first) first = e.t;
    if (e.t > last) last = e.t;
    if (firstToken === Infinity && (e.type === "text" || e.type === "reasoning")) firstToken = e.t;
  }
  if (!Number.isFinite(first) || !Number.isFinite(last)) return { ttft: null, total: null };
  const total = Math.max(0, last - first);
  const leadIn = Number.isFinite(firstToken) ? firstToken - first : 0;
  return { ttft: leadIn > 0 ? leadIn : null, total };
}

/** A turn failed if its log carries an error envelope or it streamed no answer. */
function isFailedTurn(t: RecentTurn): boolean {
  const hasError = (t.events ?? []).some((e) => (e as { type?: string }).type === "error");
  return hasError || t.content.trim().length === 0;
}

/** p95 of a numeric sample set (nearest-rank), or null when empty. */
function p95(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

/** Build one agent's telemetry from its folded turns plus its live run state. */
function agentTelemetry(
  agentId: string,
  turns: RecentTurn[],
  running: number,
  paused: number,
  lastActivityAt: number | null,
  now: number,
): AgentTelemetry {
  const completed = turns.length;
  const failed = turns.filter(isFailedTurn).length;
  const errorRate = completed > 0 ? failed / completed : null;

  const totals: number[] = [];
  let lastTtft: number | null = null;
  let lastTotal: number | null = null;
  for (const t of turns) {
    const { ttft, total } = latencyOf(t.events);
    if (ttft !== null) lastTtft = ttft;
    if (total !== null) {
      totals.push(total);
      lastTotal = total;
    }
  }
  const latency: LatencyStats = {
    ttft: lastTtft,
    total: lastTotal,
    // p95 of full turn spans — always measurable, unlike ttft
    p95: p95(totals),
    samples: totals.length,
  };

  // a live run wins; else recent activity reads live; a run that has gone quiet
  // mid-flight reads stale; a long-quiet or never-active agent reads idle.
  let state: TelemetryState;
  const ageMs = lastActivityAt === null ? null : Math.max(0, now - lastActivityAt);
  if (running > 0) {
    state = ageMs !== null && ageMs > HEARTBEAT_STALE_MS ? "stale" : "working";
  } else if (paused > 0) {
    state = "working";
  } else if (ageMs !== null && ageMs <= HEARTBEAT_STALE_MS) {
    state = "live";
  } else {
    state = "idle";
  }

  return {
    agentId,
    state,
    heartbeatAgeMs: ageMs,
    heartbeatAt: lastActivityAt,
    queue: { running, paused },
    completed,
    throughputPerHour: completed / (WINDOW_MS / 3_600_000),
    errorRate,
    latency,
    windowMs: WINDOW_MS,
    hasHistory: completed > 0,
  };
}

/** Compact age ("—" when never, else "2.4s" / "3m" / "1.2h" / "2d"). */
function formatAge(ms: number | null): string {
  if (ms === null) return "—";
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Compact uptime ("—" under a minute, else "42m" / "3h 42m" / "2d 4h"). */
export function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return "—";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return rm ? `${h}h ${rm}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d}d ${rh}h` : `${d}d`;
}

/**
 * The roster's `AgentHealth` cells, filled from real telemetry. Only the five
 * measured cells are derived; `meters`/`beats`/`incidents` stay empty (the
 * Health pane shows its own "no telemetry yet" line) rather than carrying
 * fabricated rows.
 */
export function healthFromTelemetry(t: AgentTelemetry, uptimeMs: number) {
  const { running, paused } = t.queue;
  const queue =
    running > 0
      ? `${running} running`
      : paused > 0
        ? `${paused} paused`
        : "0 queued";
  return {
    heartbeat: formatAge(t.heartbeatAgeMs),
    // "healthy" = not stale and not offline; idle is a resting-but-ok reading
    beatOk: t.state !== "stale" && t.state !== "offline",
    uptime: formatUptime(uptimeMs),
    queue,
    errRate: t.errorRate === null ? "—" : `${(t.errorRate * 100).toFixed(1)}%`,
    errWarn: t.errorRate !== null && t.errorRate > 0.05,
    throughput: t.hasHistory ? `${Math.round(t.throughputPerHour)} tasks/hr` : "—",
    meters: [],
    beats: [],
    incidents: [],
  };
}

/** The runtime `Agent` list with its health cells filled from real telemetry. */
export function listAgentsWithTelemetry(): Agent[] {
  const t = buildTelemetry();
  return listAgents().map((a) => {
    const at = t.agents[a.id];
    return at ? { ...a, health: healthFromTelemetry(at, t.uptimeMs) } : a;
  });
}

/** Fold the whole system's state into one snapshot the UI polls. */
export function buildTelemetry(now: number = Date.now()): SwarmTelemetry {
  const since = now - WINDOW_MS;
  const turns = recentAssistantTurns(since);
  const runs = listActiveRuns();

  // Attribute each in-flight run to its agent via the session it belongs to.
  const sessionAgents = sessionAgentMap(runs.map((r) => r.sessionId));
  const runningByAgent = new Map<string, number>();
  const pausedByAgent = new Map<string, number>();
  const runLastByAgent = new Map<string, number>();
  for (const r of runs) {
    const agentId = sessionAgents.get(r.sessionId) ?? "";
    const bucket = r.paused ? pausedByAgent : runningByAgent;
    bucket.set(agentId, (bucket.get(agentId) ?? 0) + 1);
    const prev = runLastByAgent.get(agentId);
    if (prev === undefined || r.lastEventAt > prev) runLastByAgent.set(agentId, r.lastEventAt);
  }

  const byAgent = new Map<string, RecentTurn[]>();
  for (const t of turns) {
    const list = byAgent.get(t.agentId);
    if (list) list.push(t);
    else byAgent.set(t.agentId, [t]);
  }

  const out: Record<string, AgentTelemetry> = {};
  for (const a of listAgents()) {
    const agentTurns = byAgent.get(a.id) ?? [];
    let last: number | null = null;
    for (const t of agentTurns) if (last === null || t.createdAt > last) last = t.createdAt;
    const runLast = runLastByAgent.get(a.id);
    if (runLast !== undefined && (last === null || runLast > last)) last = runLast;
    out[a.id] = agentTelemetry(
      a.id,
      agentTurns,
      runningByAgent.get(a.id) ?? 0,
      pausedByAgent.get(a.id) ?? 0,
      last,
      now,
    );
  }

  const totalFailed = turns.filter(isFailedTurn).length;
  return {
    at: now,
    uptimeMs: process.uptime() * 1000,
    heartbeatAt: getLastActivityAt(),
    agents: out,
    totals: {
      running: runs.filter((r) => !r.paused).length,
      paused: runs.filter((r) => r.paused).length,
      completed: turns.length,
      errorRate: turns.length > 0 ? totalFailed / turns.length : null,
    },
  };
}
