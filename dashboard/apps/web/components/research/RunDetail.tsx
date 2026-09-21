"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getRun,
  listEvents,
  listEvaluationsLean,
  listResults,
  runAction,
  streamRun,
  ResearchApiError,
  type Candidate,
  type Iteration,
  type ResearchEvaluationLean,
  type ResearchEvent,
  type ResearchResult,
  type RunAction,
  type RunDetailData,
} from "@/lib/research-loop";
import {
  emptyEvaluationFilters,
  emptyTimelineFilters,
  type EvaluationFilters,
  type TimelineFilters,
} from "@/lib/research-analytics";
import { ResearchLoop } from "./ResearchLoop";
import { EvaluationsPanel } from "./Evaluator";
import { TimelinePanel } from "./Timeline";
import {
  clock,
  formatDuration,
  isTerminal,
  relativeTime,
  stageLabel,
  StateNote,
  Stat,
  StatusBadge,
  truncate,
} from "./shared";

type Tab = "overview" | "loop" | "timeline" | "evaluations" | "events" | "knowledge";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "loop", label: "Loop" },
  { id: "timeline", label: "Timeline" },
  { id: "evaluations", label: "Evaluations" },
  { id: "events", label: "Events" },
  { id: "knowledge", label: "Knowledge Impact" },
];

/** Live-stream connection state, surfaced honestly (never silently empty). */
type StreamState = "idle" | "connecting" | "live" | "reconnecting" | "ended" | "error";

export function RunDetail({ runId, onBack }: { runId: string; onBack: () => void }) {
  const [data, setData] = useState<RunDetailData | null>(null);
  const [load, setLoad] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState("");
  const [tab, setTab] = useState<Tab>("overview");

  const [events, setEvents] = useState<ResearchEvent[]>([]);
  const [streamState, setStreamState] = useState<StreamState>("idle");
  const seenIds = useRef<Set<string>>(new Set());
  const eventsRef = useRef<HTMLDivElement>(null);

  const [pendingAction, setPendingAction] = useState<RunAction | null>(null);
  const [actionError, setActionError] = useState("");

  // Evaluations are loaded lean (scalars + counts) so a run with thousands of
  // iterations is complete and cheap; the heavy arrays load on expansion.
  const [evaluations, setEvaluations] = useState<ResearchEvaluationLean[]>([]);
  const [evalLoad, setEvalLoad] = useState<"loading" | "ready" | "error">("loading");
  const [evalError, setEvalError] = useState("");

  const [results, setResults] = useState<ResearchResult[]>([]);

  // Filter state lives here (not in the URL) so it survives switching tabs —
  // Timeline and Evaluations each keep their own, and neither loses it when the
  // operator opens a different tab and comes back.
  const [timelineFilters, setTimelineFilters] = useState<TimelineFilters>(emptyTimelineFilters);
  const [evalFilters, setEvalFilters] = useState<EvaluationFilters>(emptyEvaluationFilters);

  const run = data?.run ?? null;

  const refetch = useCallback(async () => {
    try {
      const d = await getRun(runId);
      setData(d);
      setLoad("ready");
      setLoadError("");
    } catch (err) {
      setLoad("error");
      setLoadError(err instanceof ResearchApiError ? err.message : String(err));
    }
  }, [runId]);

  const loadEvals = useCallback(async () => {
    try {
      const { evaluations: evs } = await listEvaluationsLean(runId);
      setEvaluations(evs);
      setEvalLoad("ready");
      setEvalError("");
    } catch (err) {
      setEvalLoad("error");
      setEvalError(err instanceof ResearchApiError ? err.message : String(err));
    }
  }, [runId]);

  // The sub-agent's executed results + activity trace. Loaded alongside the run;
  // a load failure degrades quietly (the timeline still renders) rather than
  // blanking the run.
  const loadResults = useCallback(async () => {
    try {
      const { results: rs } = await listResults(runId);
      setResults(rs);
    } catch {
      setResults([]);
    }
  }, [runId]);

  // Load on mount. The parent keys this component by run id, so switching runs
  // remounts it — no per-run state can leak between runs, and there is nothing
  // to reset in an effect.
  useEffect(() => {
    void (async () => {
      await refetch();
      await loadEvals();
      await loadResults();
    })();
  }, [refetch, loadEvals, loadResults]);

  // Live event subscription. A terminal run's log is finite, so it is fetched
  // once; a live run attaches over SSE (which replays the durable log, then
  // follows). Dedupe by event id makes a reconnect idempotent.
  useEffect(() => {
    if (!run) return;
    let cancelled = false;
    let ctrl: AbortController | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const push = (ev: ResearchEvent) => {
      if (cancelled || seenIds.current.has(ev.id)) return;
      seenIds.current.add(ev.id);
      setEvents((prev) => (prev.length >= 1000 ? [...prev.slice(-999), ev] : [...prev, ev]));
      // The evaluator persists its record just before it emits RESEARCH_EVALUATED,
      // so refreshing on that event lands the new evaluation live.
      if (ev.type === "RESEARCH_EVALUATED") void loadEvals();
      // The result (and its activity trace) is persisted before its event.
      if (ev.type === "RESEARCH_RESULT_CREATED") void loadResults();
      if (isTerminalEvent(ev.type)) void refetch();
    };

    if (isTerminal(run.status)) {
      // Finite log — one fetch, no socket. Entered async so no setState runs
      // synchronously in the effect body.
      void (async () => {
        setStreamState("ended");
        try {
          const r = await listEvents(runId);
          if (!cancelled) r.events.forEach(push);
        } catch {
          if (!cancelled) setStreamState("error");
        }
      })();
      return () => {
        cancelled = true;
      };
    }

    const connect = () => {
      if (cancelled) return;
      setStreamState(attempt === 0 ? "connecting" : "reconnecting");
      ctrl = new AbortController();
      void streamRun(runId, {
        signal: ctrl.signal,
        onEvent: (ev) => {
          if (cancelled) return;
          attempt = 0;
          setStreamState("live");
          push(ev);
        },
        onDone: () => {
          if (!cancelled) {
            setStreamState("ended");
            void refetch();
          }
        },
        onError: () => {
          if (cancelled) return;
          attempt += 1;
          if (attempt > 6) {
            setStreamState("error");
            return;
          }
          setStreamState("reconnecting");
          retry = setTimeout(connect, Math.min(800 * attempt, 5000));
        },
      });
    };
    connect();

    return () => {
      cancelled = true;
      ctrl?.abort();
      if (retry) clearTimeout(retry);
    };
  }, [runId, run, refetch, loadEvals, loadResults]);

  // Keep the event log pinned to the newest line while the operator is at the end.
  useEffect(() => {
    const el = eventsRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (near) el.scrollTop = el.scrollHeight;
  }, [events]);

  const act = useCallback(
    async (action: RunAction) => {
      setPendingAction(action);
      setActionError("");
      try {
        await runAction(runId, action);
        await refetch();
      } catch (err) {
        setActionError(err instanceof ResearchApiError ? err.message : String(err));
      } finally {
        setPendingAction(null);
      }
    },
    [runId, refetch],
  );

  const mutations = useMemo(() => aggregateMutations(data?.iterations ?? []), [data]);

  if (load === "loading" && !data) {
    return (
      <div className="research-detail">
        <DetailHead onBack={onBack} title="Research run" />
        <StateNote kind="loading" title="Loading research run…" />
      </div>
    );
  }
  if (load === "error" && !data) {
    return (
      <div className="research-detail">
        <DetailHead onBack={onBack} title="Research run" />
        <StateNote kind="error" title="Unable to load this run." detail={loadError} onRetry={() => void refetch()} />
      </div>
    );
  }
  if (!run) return null;

  return (
    <div className="research-detail">
      <DetailHead onBack={onBack} title={run.objective || "(untitled run)"}>
        <div className="rld-head-meta">
          <StatusBadge status={run.status} live={run.status === "RUNNING"} />
          <span className="rl-mono">{stageLabel(run.stage)}</span>
          <span className="rl-mono">iteration {run.iteration}</span>
          <span className="rl-mono">{formatDuration(run.elapsedS)}</span>
          {data?.driving ? <span className="rl-driven">driver active</span> : null}
        </div>
      </DetailHead>

      <Controls
        status={run.status}
        driving={!!data?.driving}
        pending={pendingAction}
        error={actionError}
        onAct={act}
      />

      <nav className="rld-tabs" role="tablist" aria-label="Run detail sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`rld-tab ${tab === t.id ? "is-active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {t.id === "evaluations" && evaluations.length ? (
              <span className="rld-tab-count">{evaluations.length}</span>
            ) : null}
            {t.id === "events" && events.length ? <span className="rld-tab-count">{events.length}</span> : null}
            {t.id === "knowledge" && mutations.total ? <span className="rld-tab-count">{mutations.total}</span> : null}
          </button>
        ))}
      </nav>

      <div className="rld-body">
        {tab === "overview" ? <Overview data={data!} events={events} /> : null}
        {tab === "loop" ? (
          <div className="rld-section">
            <ResearchLoop status={run.status} stage={run.stage} iteration={run.iteration} />
          </div>
        ) : null}
        {tab === "timeline" ? (
          <TimelinePanel
            iterations={data?.iterations ?? []}
            status={run.status}
            results={results}
            iterationCount={data?.iterationCount}
            filters={timelineFilters}
            setFilters={setTimelineFilters}
          />
        ) : null}
        {tab === "evaluations" ? (
          <EvaluationsPanel
            evaluations={evaluations}
            load={evalLoad}
            error={evalError}
            iterations={data?.iterations ?? []}
            filters={evalFilters}
            setFilters={setEvalFilters}
            onRetry={() => void loadEvals()}
          />
        ) : null}
        {tab === "events" ? (
          <Events events={events} streamState={streamState} ref={eventsRef} onReconnect={() => setStreamState("idle")} />
        ) : null}
        {tab === "knowledge" ? <KnowledgeImpact data={data!} mutations={mutations} /> : null}
      </div>
    </div>
  );
}

/* ── header ─────────────────────────────────────────────────────────────── */

function DetailHead({
  onBack,
  title,
  children,
}: {
  onBack: () => void;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="rld-head">
      <button type="button" className="rld-back" onClick={onBack}>
        ← Runs
      </button>
      <div className="rld-head-main">
        <h2 title={title}>{title}</h2>
        {children}
      </div>
    </div>
  );
}

/* ── lifecycle controls ─────────────────────────────────────────────────── */

function Controls({
  status,
  driving,
  pending,
  error,
  onAct,
}: {
  status: RunDetailData["run"]["status"];
  driving: boolean;
  pending: RunAction | null;
  error: string;
  onAct: (a: RunAction) => void;
}) {
  if (isTerminal(status)) {
    return (
      <div className="rld-controls">
        <span className="rld-controls-note">This run is {status.toLowerCase()} — no execution controls.</span>
      </div>
    );
  }
  const paused = status === "PAUSED" || status === "WAITING" || status === "BLOCKED";
  // The run STATUS is the authority on which controls apply — `driving` only
  // refines the running case, because the background driver task can still be
  // winding down after a pause (so it must not hide Resume). A paused run is
  // safe to resume/advance by hand; a running one owned by the driver is only
  // pausable (Advance/Step would race it).
  const buttons: Array<{ a: RunAction; label: string; primary?: boolean }> = paused
    ? [
        { a: "resume", label: "Resume", primary: true },
        { a: "advance", label: "Advance" },
        { a: "step", label: "Step" },
        { a: "cancel", label: "Cancel" },
      ]
    : driving
      ? [
          { a: "pause", label: "Pause" },
          { a: "cancel", label: "Cancel" },
        ]
      : [
          { a: "advance", label: "Advance" },
          { a: "step", label: "Step" },
          { a: "cancel", label: "Cancel" },
        ];

  return (
    <div className="rld-controls">
      <div className="rld-controls-btns">
        {buttons.map((b) => (
          <button
            key={b.a}
            type="button"
            className={`rl-btn ${b.primary ? "rl-btn-primary" : ""}`}
            disabled={pending !== null}
            onClick={() => onAct(b.a)}
          >
            {pending === b.a ? `${b.label}…` : b.label}
          </button>
        ))}
      </div>
      {error ? <span className="rld-controls-err" role="alert">{error}</span> : null}
    </div>
  );
}

/* ── overview ───────────────────────────────────────────────────────────── */

function Overview({ data, events }: { data: RunDetailData; events: ResearchEvent[] }) {
  const { run, candidates } = data;
  const p = run.progress;
  const cap = run.budget.max_iterations;
  const pct = cap ? Math.min(100, Math.round((run.iteration / cap) * 100)) : null;
  const openCandidates = candidates.filter((c) => c.status === "open" || c.status === "selected");

  return (
    <div className="rld-section">
      <div className="rl-objective">
        <div className="rl-obj-label">Objective</div>
        <p className="rl-obj-text">{run.objective || "(no objective recorded)"}</p>
        {run.success_criteria.length ? (
          <ul className="rl-criteria">
            {run.success_criteria.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="rl-stats">
        <Stat k="Status" v={<StatusBadge status={run.status} live={run.status === "RUNNING"} />} />
        <Stat k="Stage" v={stageLabel(run.stage)} />
        <Stat
          k="Iteration"
          v={cap ? `${run.iteration} / ${cap}` : String(run.iteration)}
        />
        <Stat k="Elapsed" v={formatDuration(run.elapsedS)} />
        <Stat k="Started" v={relativeTime(run.startedAt)} title={new Date(run.startedAt).toLocaleString()} />
        <Stat k="Last activity" v={relativeTime(run.updatedAt)} title={new Date(run.updatedAt).toLocaleString()} />
        <Stat k="Events" v={events.length ? String(events.length) : "—"} title="durable event log length" />
        <Stat
          k="Termination"
          v={run.terminationReason ? run.terminationReason.replace(/_/g, " ").toLowerCase() : "—"}
          title="why the loop stopped, when it has"
        />
      </div>

      {pct !== null ? (
        <div className="rl-progress" aria-label="Iteration budget used">
          <div className="rl-progress-bar">
            <span className="rl-progress-fill" style={{ width: `${pct}%` }} />
          </div>
          <span className="rl-progress-cap">{pct}% of iteration budget</span>
        </div>
      ) : null}

      <div className="rl-subhead">Progress (information gain)</div>
      <div className="rl-stats rl-stats-4">
        <Stat k="Info gain" v={p.info_gain.toFixed(2)} />
        <Stat k="Knowledge +" v={p.knowledge_created} title="knowledge entities created" />
        <Stat k="Updated" v={p.knowledge_updated} title="knowledge entities enriched" />
        <Stat k="Relationships +" v={p.relationships_added} />
        <Stat k="Unknowns +" v={p.unknowns_created} />
        <Stat k="Unknowns resolved" v={p.unknowns_resolved} />
        <Stat k="Conflicts found" v={p.conflicts_found} />
        <Stat k="Evidence items" v={p.evidence_items} />
        <Stat k="Hypotheses rejected" v={p.hypotheses_rejected} />
        <Stat k="Low-value streak" v={p.low_value_streak} title="consecutive iterations below the information-gain gate" />
      </div>

      <div className="rl-subhead">
        Candidates <span className="rl-subhead-note">{openCandidates.length} open of {candidates.length}</span>
      </div>
      {candidates.length ? (
        <ul className="rl-cands">
          {[...candidates].sort((a, b) => b.priority - a.priority).slice(0, 12).map((c) => (
            <CandidateRow key={c.id} c={c} />
          ))}
        </ul>
      ) : (
        <div className="rl-muted">No candidates recorded yet.</div>
      )}
    </div>
  );
}

function CandidateRow({ c }: { c: Candidate }) {
  const { text, full } = truncate(c.question, 160);
  return (
    <li className="rl-cand" data-status={c.status}>
      <span className="rl-cand-status" data-status={c.status}>{c.status}</span>
      <div className="rl-cand-main">
        <div className="rl-cand-q" title={full}>{text}</div>
        <div className="rl-cand-meta">
          priority {c.priority.toFixed(2)} · gain {c.expected_information_gain} · cost {c.estimated_cost}
          {c.branch && c.branch !== "main" ? ` · branch ${c.branch}` : ""}
          {c.source_gap_kind ? ` · gap ${c.source_gap_kind}` : ""}
        </div>
      </div>
    </li>
  );
}

/* ── events ─────────────────────────────────────────────────────────────── */

function Events({
  events,
  streamState,
  ref,
  onReconnect,
}: {
  events: ResearchEvent[];
  streamState: StreamState;
  ref: React.RefObject<HTMLDivElement | null>;
  onReconnect: () => void;
}) {
  return (
    <div className="rld-section rld-events-wrap">
      <div className="rl-stream-bar" data-state={streamState}>
        <span className={`rl-stream-dot ${streamState === "live" ? "is-live" : ""}`} aria-hidden />
        <span>{STREAM_LABEL[streamState]}</span>
        {streamState === "error" ? (
          <button type="button" className="rl-btn rl-btn-sm" onClick={onReconnect}>
            Reconnect
          </button>
        ) : null}
      </div>
      {events.length ? (
        <div className="rl-events" ref={ref}>
          {events.map((ev) => (
            <EventRow key={ev.id} ev={ev} />
          ))}
        </div>
      ) : (
        <StateNote
          kind={streamState === "error" ? "error" : "empty"}
          title={streamState === "error" ? "Live stream disconnected." : "No events yet."}
          detail={streamState === "error" ? "The run's event stream could not be reached." : "Events appear as the loop runs."}
          onRetry={streamState === "error" ? onReconnect : undefined}
        />
      )}
    </div>
  );
}

const STREAM_LABEL: Record<StreamState, string> = {
  idle: "stream idle",
  connecting: "connecting…",
  live: "live",
  reconnecting: "reconnecting…",
  ended: "stream ended",
  error: "stream disconnected",
};

function EventRow({ ev }: { ev: ResearchEvent }) {
  const [open, setOpen] = useState(false);
  const summary = eventSummary(ev);
  const long = summary.length > 140 || Object.keys(ev.data).length > 2;
  return (
    <div className="rl-ev" data-cat={eventCategory(ev.type)}>
      <span className="rl-ev-time rl-mono">{clock(ev.ts)}</span>
      <span className="rl-ev-type">{ev.type}</span>
      {ev.iteration_index != null ? <span className="rl-ev-iter rl-mono">#{ev.iteration_index}</span> : null}
      <span className="rl-ev-msg" title={long && !open ? summary : undefined}>
        {open ? summary : truncate(summary, 140).text}
      </span>
      {long ? (
        <button type="button" className="rl-ev-more" onClick={() => setOpen((v) => !v)}>
          {open ? "less" : "more"}
        </button>
      ) : null}
      {open ? <pre className="rl-ev-json">{JSON.stringify(ev.data, null, 2)}</pre> : null}
    </div>
  );
}

/* ── knowledge impact ───────────────────────────────────────────────────── */

interface Mutations {
  total: number;
  byOp: Record<string, MutationRef[]>;
}

interface MutationRef {
  op: string;
  id: string;
  question: string;
  iteration: number;
}

/** Collect every knowledge mutation an iteration recorded, with provenance. */
function aggregateMutations(iterations: Iteration[]): Mutations {
  const byOp: Record<string, MutationRef[]> = {};
  let total = 0;
  for (const it of iterations) {
    for (const u of it.knowledge_updates ?? []) {
      const op = (u.op || "?").toLowerCase();
      (byOp[op] ??= []).push({ op, id: u.id ?? "", question: u.question ?? "", iteration: it.index });
      total += 1;
    }
  }
  return { total, byOp };
}

const OP_LABEL: Record<string, string> = {
  create: "Created",
  update: "Updated",
  enrich: "Enriched",
  duplicate: "Duplicate (skipped)",
  conflict: "Conflict recorded",
  supersede: "Superseded",
  verified: "Verified",
  interpretation: "Interpretation noted",
  unknown: "Unknown raised",
  error: "Failed",
};

function KnowledgeImpact({ data, mutations }: { data: RunDetailData; mutations: Mutations }) {
  const p = data.run.progress;
  const hasAny = mutations.total > 0 || p.knowledge_created + p.knowledge_updated + p.relationships_added > 0;

  return (
    <div className="rld-section">
      <div className="rl-impact">
        <Stat k="Entities created" v={p.knowledge_created} />
        <Stat k="Entities updated" v={p.knowledge_updated} />
        <Stat k="Relationships added" v={p.relationships_added} />
        <Stat k="Unknowns identified" v={p.unknowns_created} />
        <Stat k="Unknowns resolved" v={p.unknowns_resolved} />
        <Stat k="Conflicts found" v={p.conflicts_found} />
      </div>

      {!hasAny ? (
        <StateNote
          kind="empty"
          title="No knowledge changes yet."
          detail="This run has not produced findings that changed the knowledge graph."
        />
      ) : (
        <>
          <div className="rl-subhead">
            Provenance <span className="rl-subhead-note">each change → the iteration that made it</span>
          </div>
          <div className="rl-prov">
            {Object.entries(mutations.byOp)
              .sort((a, b) => b[1].length - a[1].length)
              .map(([op, items]) => (
                <div key={op} className="rl-prov-group">
                  <div className="rl-prov-op" data-op={op}>
                    {OP_LABEL[op] ?? op} <span className="rl-prov-count">{items.length}</span>
                  </div>
                  <ul className="rl-prov-list">
                    {items.slice(0, 40).map((m, i) => (
                      <li key={i} className="rl-prov-item">
                        {m.id ? <span className="rl-prov-id">[[{m.id}]]</span> : <span className="rl-muted">(no id)</span>}
                        <span className="rl-prov-src">
                          iteration {m.iteration}
                          {m.question ? ` · ${truncate(m.question, 70).text}` : ""}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
          </div>
        </>
      )}
    </div>
  );
}

/* ── helpers ────────────────────────────────────────────────────────────── */

function isTerminalEvent(type: string): boolean {
  return type === "RESEARCH_COMPLETED" || type === "RESEARCH_CANCELLED" || type === "RESEARCH_FAILED";
}

function eventCategory(type: string): string {
  if (type.startsWith("KNOWLEDGE_")) return "knowledge";
  if (type.startsWith("EVIDENCE")) return "evidence";
  if (type.startsWith("ITERATION")) return "iteration";
  if (type.startsWith("CANDIDATE")) return "candidate";
  if (type.startsWith("RESEARCH_")) return "research";
  if (type === "NEXT_ACTION_SELECTED" || type === "STAGE_CHANGED") return "loop";
  return "misc";
}

/** A one-line human summary of an event's payload, from its real fields. */
function eventSummary(ev: ResearchEvent): string {
  const d = ev.data ?? {};
  const pick = (k: string) => (typeof d[k] === "string" ? (d[k] as string) : "");
  const q = pick("question") || pick("objective") || pick("reason") || pick("message") || pick("title");
  if (q) return q;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(d)) {
    if (v == null) continue;
    if (Array.isArray(v)) parts.push(`${k}: ${v.length}`);
    else if (typeof v === "object") parts.push(`${k}: {…}`);
    else parts.push(`${k}: ${String(v)}`);
    if (parts.length >= 3) break;
  }
  return parts.join(" · ") || "—";
}
