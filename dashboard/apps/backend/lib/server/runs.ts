import { appendMessage } from "@/lib/db/sessions";
import type { RunEvent } from "@dashboard/shared";

/**
 * In-process registry of in-flight agent runs, one per chat session.
 *
 * A run is owned by the backend, not by the browser that started it. The
 * upstream fetch is deliberately NOT tied to the request's AbortSignal, and the
 * event pump runs detached — so a run survives the client navigating away or
 * reloading, streams to whoever is attached (replaying what was already seen),
 * and persists its reply + full event log when it ends. A reload therefore
 * re-renders the steps and the answer instead of an infinite placeholder.
 *
 * A run paused for tool approval is retained (not persisted, not dropped): the
 * operator's decision resumes the SAME run, so the reply persists once, whole.
 *
 * One Node process serves every request, so a module-level Map is the right
 * scope — the same reasoning as the in-process Semaphore.
 */

/** A client reading the run's stream. `push` must never throw. */
export interface RunSink {
  push(frame: string): void;
  close(): void;
}

export interface ActiveRun {
  sessionId: string;
  /** epoch ms this run began — drives the live heartbeat/uptime reading */
  startedAt: number;
  /** aborts the current upstream fetch (and, via disconnect, the agent's run) */
  controller: AbortController;
  /** every envelope seen so far, each stamped with its receipt time (`t`) */
  events: RunEvent[];
  /** the answer text accumulated from `text` envelopes, across a pause/resume */
  text: string;
  subscribers: Set<RunSink>;
  /** true once the run has settled and been persisted */
  done: boolean;
  /** true while paused awaiting the operator's approval */
  paused: boolean;
  /** set when the operator pressed Stop */
  aborted: boolean;
  error?: string;
}

const globalForRuns = globalThis as unknown as { __dashboardRuns?: Map<string, ActiveRun> };
function registry(): Map<string, ActiveRun> {
  if (!globalForRuns.__dashboardRuns) globalForRuns.__dashboardRuns = new Map();
  return globalForRuns.__dashboardRuns;
}

/** The wall-clock of the most recent run activity in the process — a turn's
 *  first event, each subsequent envelope, and each run start. Survives a run
 *  ending (the map entry is dropped), so it remains a truthful "last seen the
 *  agent working" reading for the heartbeat. Initialised to process start. */
const globalForActivity = globalThis as unknown as { __dashboardLastActivity?: number };
function noteActivity(t: number): void {
  const prev = globalForActivity.__dashboardLastActivity ?? 0;
  if (t > prev) globalForActivity.__dashboardLastActivity = t;
}
/** The most recent agent activity anywhere in the process (epoch ms). Falls
 *  back to process start so a freshly-restarted server still reads a heartbeat. */
export function getLastActivityAt(): number {
  return globalForActivity.__dashboardLastActivity ?? Math.floor(Date.now() - process.uptime() * 1000);
}

/** A read-only summary of one in-flight run, for telemetry. */
export interface ActiveRunSummary {
  sessionId: string;
  startedAt: number;
  paused: boolean;
  /** the newest event receipt time this run has seen */
  lastEventAt: number;
}

/** Snapshot of every in-flight (running or paused) run in the process. */
export function listActiveRuns(): ActiveRunSummary[] {
  const out: ActiveRunSummary[] = [];
  for (const run of registry().values()) {
    if (run.done) continue;
    const last = run.events.length ? run.events[run.events.length - 1].t ?? run.startedAt : run.startedAt;
    out.push({ sessionId: run.sessionId, startedAt: run.startedAt, paused: run.paused, lastEventAt: last });
  }
  return out;
}

/** The session's active run, if one is in flight (running or paused). */
export function getRun(sessionId: string): ActiveRun | undefined {
  return registry().get(sessionId);
}

/** Begin a run, or return null if this session already has one. */
export function startRun(sessionId: string): ActiveRun | null {
  const map = registry();
  if (map.has(sessionId)) return null;
  const now = Date.now();
  const run: ActiveRun = {
    sessionId,
    startedAt: now,
    controller: new AbortController(),
    events: [],
    text: "",
    subscribers: new Set(),
    done: false,
    paused: false,
    aborted: false,
  };
  map.set(sessionId, run);
  noteActivity(now);
  return run;
}

/** Continue a paused run: a fresh upstream fetch, accumulators kept intact. */
export function resumeRun(run: ActiveRun): ActiveRun {
  run.controller = new AbortController();
  run.paused = false;
  run.aborted = false;
  run.error = undefined;
  run.done = false;
  return run;
}

/** Stop a run: abort the upstream fetch. The pump still persists the partial. */
export function abortRun(sessionId: string): boolean {
  const run = registry().get(sessionId);
  if (!run || run.done) return false;
  run.aborted = true;
  run.controller.abort();
  return true;
}

/** Remove a run that never began pumping (e.g. the upstream fetch failed). */
export function killRun(sessionId: string): void {
  const run = registry().get(sessionId);
  if (run) endRun(run);
}

function closeSubscribers(run: ActiveRun): void {
  for (const sink of run.subscribers) sink.close();
  run.subscribers.clear();
}

/** A true finish: mark done, close readers, drop from the registry. */
function endRun(run: ActiveRun): void {
  run.done = true;
  closeSubscribers(run);
  const map = registry();
  if (map.get(run.sessionId) === run) map.delete(run.sessionId);
}

/** SSE comment frame — invisible to `data:`-reading clients, keeps proxies open. */
const KEEPALIVE = ": keepalive\n\n";
const HEARTBEAT_MS = 10_000;

const encoder = new TextEncoder();
/** Encode one envelope as an SSE `data:` frame. */
function frame(ev: RunEvent): string {
  return `data: ${JSON.stringify(ev)}\n\n`;
}

/**
 * Read the agent's SSE body into the run's event log, broadcasting each
 * envelope to attached readers, then persist the assistant turn and close them.
 * Detached: the caller must not await this as part of the response.
 *
 * A run that pauses for approval is left in the registry (its accumulators
 * intact) for the resume call; it is neither persisted nor done, so the whole
 * turn persists once, when the resumed run finally settles.
 */
export async function pumpRun(run: ActiveRun, body: ReadableStream<Uint8Array>): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawInterrupt = false;
  const heartbeat = setInterval(() => {
    for (const sink of run.subscribers) sink.push(KEEPALIVE);
  }, HEARTBEAT_MS);

  const broadcast = (ev: RunEvent) => {
    const f = frame(ev);
    for (const sink of run.subscribers) sink.push(f);
  };

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
          if (!line.startsWith("data:")) continue; // skips ": keepalive" comments
          const payload = line.slice(5).trim();
          if (!payload) continue;
          let ev: RunEvent;
          try {
            ev = JSON.parse(payload) as RunEvent;
          } catch {
            continue;
          }
          ev.t = Date.now();
          run.events.push(ev);
          noteActivity(ev.t);
          if (ev.type === "text" && typeof ev.text === "string") run.text += ev.text;
          if (ev.type === "interrupt") sawInterrupt = true;
          // The agent's own `done` is swallowed: we emit `done` ourselves in the
          // finally block AFTER persisting, so a client that reacts to it always
          // reads a row that already exists.
          if (ev.type === "done") continue;
          broadcast(ev);
        }
      }
    }
  } catch (err) {
    // An abort lands here as a thrown read error; that is the operator's Stop,
    // not a failure, so it is not surfaced as an error envelope.
    if (!run.aborted) {
      run.error = String(err);
      broadcast({ type: "error", message: String(err), t: Date.now() });
    }
  } finally {
    clearInterval(heartbeat);
    // Paused for approval: keep the run (and its accumulators) for the resume
    // call; end the clients' streams but do not persist or drop the entry.
    if (sawInterrupt && !run.aborted) {
      run.paused = true;
      broadcast({ type: "done", t: Date.now() });
      closeSubscribers(run);
      return;
    }
    // Persist first, so a client that reacts to `done` sees the row already.
    if (run.events.length > 0 || run.aborted) {
      try {
        appendMessage(run.sessionId, {
          role: "assistant",
          content: run.text,
          // Anchor the log with the run's start stamp. The recorded envelopes
          // only begin when the upstream first emits, so without this the folded
          // latency would measure first-envelope→last (missing time-to-first-
          // token) and understate a slow turn by seconds. With the anchor,
          // telemetry's `total` is real end-to-end and `ttft` becomes measurable.
          // Clients ignore the unknown `start` type, so replay is unaffected.
          events: JSON.stringify([{ type: "start", t: run.startedAt }, ...run.events]),
        });
      } catch {
        /* history save is best-effort; the reply may already be on screen */
      }
    }
    broadcast({ type: "done", t: Date.now() });
    endRun(run);
  }
}

/**
 * The response stream for a run: replay recorded events from `fromIndex`, then
 * follow it live until it settles. A client disconnect only unsubscribes — it
 * must never abort the run. `fromIndex` is 0 for a fresh attach and the current
 * length for a resume, where the client already holds the pre-pause events.
 */
export function runStream(run: ActiveRun, fromIndex = 0): ReadableStream<Uint8Array> {
  let unsubscribe: (() => void) | undefined;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const push = (f: string) => {
        try {
          controller.enqueue(encoder.encode(f));
        } catch {
          /* the reader went away */
        }
      };
      const sink: RunSink = {
        push,
        close: () => {
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        },
      };
      // Replay synchronously before subscribing, so nothing is missed or doubled.
      for (let i = fromIndex; i < run.events.length; i++) push(frame(run.events[i]));
      if (run.done) {
        controller.close();
        return;
      }
      run.subscribers.add(sink);
      unsubscribe = () => run.subscribers.delete(sink);
    },
    cancel() {
      unsubscribe?.();
    },
  });
}

/** A one-frame stream that just ends — used when a session has no active run. */
export function endedStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(frame({ type: "done", t: Date.now() })));
      controller.close();
    },
  });
}
