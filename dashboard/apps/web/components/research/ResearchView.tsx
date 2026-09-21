"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWorkspace } from "@/components/providers/workspace";
import { Modal } from "@/components/ui/Modal";
import {
  createRun,
  getMeta,
  listRuns,
  ResearchApiError,
  type ResearchMeta,
  type RunSummary,
} from "@/lib/research-loop";
import { RunDetail } from "./RunDetail";
import { KnowledgeManager } from "./KnowledgeManager";
import { formatDuration, isTerminal, relativeTime, stageLabel, StateNote, StatusBadge } from "./shared";

type Section = "runs" | "knowledge";

/**
 * The Research workspace — the operator's control center for the Research Loop.
 * It reads live runs from `/api/research/runs*` (the agent-owned loop) and the
 * Knowledge Manager's health from `/api/research/meta`. The prior one-shot
 * `/api/research` synth flow is gone: there is exactly one Research experience.
 */
export function ResearchView() {
  const { researchRunId, closeResearchRun } = useWorkspace();
  const [section, setSection] = useState<Section>("runs");
  const [selected, setSelected] = useState<string | null>(null);

  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [runsState, setRunsState] = useState<"loading" | "ready" | "error">("loading");
  const [runsError, setRunsError] = useState("");
  const [runningIds, setRunningIds] = useState<string[]>([]);

  const [meta, setMeta] = useState<ResearchMeta | null>(null);
  const [metaState, setMetaState] = useState<"loading" | "ready" | "error">("loading");
  const [metaError, setMetaError] = useState("");

  const [creating, setCreating] = useState(false);

  const loadRuns = useCallback(async () => {
    try {
      const r = await listRuns();
      setRuns(r.runs);
      setRunningIds(r.running);
      setRunsState("ready");
      setRunsError("");
    } catch (err) {
      setRunsState("error");
      setRunsError(err instanceof ResearchApiError ? err.message : String(err));
    }
  }, []);

  const loadMeta = useCallback(async () => {
    try {
      setMeta(await getMeta());
      setMetaState("ready");
      setMetaError("");
    } catch (err) {
      setMetaState("error");
      setMetaError(err instanceof ResearchApiError ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    // Called through an async IIFE so no setState runs synchronously in the
    // effect body (the callers await the fetch first).
    void (async () => {
      await loadRuns();
      await loadMeta();
    })();
  }, [loadRuns, loadMeta]);

  // Poll the collection only while something can change — a run that is driving,
  // running, or waiting. Once everything is terminal the poll stops (the detail
  // view keeps its own SSE for the run currently open).
  const hasActive = useMemo(
    () => (runs ?? []).some((r) => !isTerminal(r.status)) || runningIds.length > 0,
    [runs, runningIds],
  );
  useEffect(() => {
    if (!hasActive) return;
    const t = setInterval(() => void loadRuns(), 4000);
    const onFocus = () => void loadRuns();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", onFocus);
    };
  }, [hasActive, loadRuns]);

  const closeDetail = useCallback(() => {
    setSelected(null);
    closeResearchRun();
    void loadRuns();
  }, [loadRuns, closeResearchRun]);

  // A deep-link from elsewhere (the Scheduler opening a run) selects that run.
  // Adjusting state during render (rather than in an effect) is React's pattern
  // for syncing to a changed prop: one render, no cascade.
  const [prevRunId, setPrevRunId] = useState(researchRunId);
  if (researchRunId !== prevRunId) {
    setPrevRunId(researchRunId);
    if (researchRunId) setSelected(researchRunId);
  }

  if (selected) {
    // Keyed by run id so selecting a different run remounts the detail view and
    // no per-run state (events, seen-ids, stream) can leak across runs.
    return <RunDetail key={selected} runId={selected} onBack={closeDetail} />;
  }

  const active = (runs ?? []).filter((r) => !isTerminal(r.status));
  const history = (runs ?? []).filter((r) => isTerminal(r.status));

  return (
    <section className="view active" data-od-id="view-research">
      <div className="panel-header research-panel-header">
        <div className="rl-seg" role="tablist" aria-label="Research sections">
          <button
            type="button"
            role="tab"
            aria-selected={section === "runs"}
            className={`rl-seg-btn ${section === "runs" ? "is-active" : ""}`}
            onClick={() => setSection("runs")}
          >
            Runs
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={section === "knowledge"}
            className={`rl-seg-btn ${section === "knowledge" ? "is-active" : ""}`}
            onClick={() => setSection("knowledge")}
          >
            Knowledge
          </button>
        </div>
        {section === "runs" ? (
          <button type="button" className="newchat-btn" data-od-id="new-research-run" onClick={() => setCreating(true)}>
            + New research run
          </button>
        ) : null}
      </div>

      {section === "runs" ? (
        <RunsSection
          runs={runs}
          state={runsState}
          error={runsError}
          runningIds={runningIds}
          active={active}
          history={history}
          onOpen={setSelected}
          onRetry={() => void loadRuns()}
        />
      ) : (
        <KnowledgeManager
          health={meta?.knowledge ?? null}
          state={metaState}
          error={metaError}
          onRetry={() => void loadMeta()}
        />
      )}

      {creating ? (
        <NewRunModal
          meta={meta}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            setSection("runs");
            setSelected(id);
            void loadRuns();
          }}
        />
      ) : null}
    </section>
  );
}

/* ── runs list ──────────────────────────────────────────────────────────── */

function RunsSection({
  runs,
  state,
  error,
  runningIds,
  active,
  history,
  onOpen,
  onRetry,
}: {
  runs: RunSummary[] | null;
  state: "loading" | "ready" | "error";
  error: string;
  runningIds: string[];
  active: RunSummary[];
  history: RunSummary[];
  onOpen: (id: string) => void;
  onRetry: () => void;
}) {
  if (state === "loading" && !runs) {
    return <StateNote kind="loading" title="Loading research runs…" />;
  }
  if (state === "error" && !runs) {
    return <StateNote kind="error" title="Unable to load research runs." detail={error} onRetry={onRetry} />;
  }
  if (!runs || runs.length === 0) {
    return <StateNote kind="empty" title="No research runs yet." detail="Start one to give the agent an objective to close gaps against." />;
  }

  return (
    <div className="rl-runs">
      {state === "error" ? (
        <div className="rl-inline-err" role="alert">
          Unable to refresh research runs — showing the last known list. <button type="button" className="rl-link" onClick={onRetry}>Retry</button>
        </div>
      ) : null}

      <RunGroup title="Active" runs={active} runningIds={runningIds} onOpen={onOpen} empty="No runs in flight." />
      <RunGroup title="History" runs={history} runningIds={runningIds} onOpen={onOpen} empty="No completed runs yet." />
    </div>
  );
}

function RunGroup({
  title,
  runs,
  runningIds,
  onOpen,
  empty,
}: {
  title: string;
  runs: RunSummary[];
  runningIds: string[];
  onOpen: (id: string) => void;
  empty: string;
}) {
  return (
    <div className="rl-group">
      <div className="rl-group-head">
        <span className="rl-group-title">{title}</span>
        <span className="rl-group-count">{runs.length}</span>
      </div>
      {runs.length ? (
        <ul className="rl-run-list">
          {runs.map((r) => (
            <RunRow key={r.id} run={r} driving={runningIds.includes(r.id)} onOpen={onOpen} />
          ))}
        </ul>
      ) : (
        <div className="rl-muted rl-group-empty">{empty}</div>
      )}
    </div>
  );
}

function RunRow({ run, driving, onOpen }: { run: RunSummary; driving: boolean; onOpen: (id: string) => void }) {
  const cap = run.budget.max_iterations;
  const pct = cap ? Math.min(100, Math.round((run.iteration / cap) * 100)) : null;
  return (
    <li>
      <button type="button" className="rl-run" data-status={run.status} onClick={() => onOpen(run.id)}>
        <span className="rl-run-status">
          <StatusBadge status={run.status} live={run.status === "RUNNING"} />
        </span>
        <span className="rl-run-main">
          <span className="rl-run-obj" title={run.objective}>{run.objective || "(untitled run)"}</span>
          <span className="rl-run-meta rl-mono">
            {stageLabel(run.stage)} · iteration {run.iteration}
            {cap ? `/${cap}` : ""} · {formatDuration(run.elapsedS)} · updated {relativeTime(run.updatedAt)}
            {driving ? " · driver active" : ""}
          </span>
        </span>
        <span className="rl-run-bar" aria-hidden>
          {pct !== null ? <span className="rl-run-bar-fill" style={{ width: `${pct}%` }} /> : null}
        </span>
      </button>
    </li>
  );
}

/* ── new run modal ──────────────────────────────────────────────────────── */

function NewRunModal({
  meta,
  onClose,
  onCreated,
}: {
  meta: ResearchMeta | null;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const { agents } = useWorkspace();
  const [objective, setObjective] = useState("");
  const [criteria, setCriteria] = useState("");
  const [domain, setDomain] = useState("");
  const [agentId, setAgentId] = useState("");
  const [maxIter, setMaxIter] = useState("50");
  const [stopping, setStopping] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const objRef = useRef<HTMLTextAreaElement>(null);

  const stopOptions = meta?.stop_conditions ?? [];

  const submit = async () => {
    const obj = objective.trim();
    if (!obj || busy) return;
    setBusy(true);
    setError("");
    try {
      const researchConfig: Record<string, unknown> = {};
      const n = Number(maxIter);
      if (Number.isFinite(n) && n > 0) researchConfig.max_iterations = Math.floor(n);
      if (stopping.length) researchConfig.stopping = stopping;
      const { run } = await createRun({
        objective: obj,
        successCriteria: criteria.split("\n").map((s) => s.trim()).filter(Boolean),
        domain: domain.trim(),
        agentId,
        researchConfig: Object.keys(researchConfig).length ? researchConfig : undefined,
      });
      onCreated(run.id);
    } catch (err) {
      setError(err instanceof ResearchApiError ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <Modal labelledBy="new-run-title" onClose={onClose} boxClassName="rl-modal-box">
      <h3 id="new-run-title">New research run</h3>
      <p className="rl-modal-sub">
        The run’s objective and constraints are handed to the agent’s Research Loop, which
        plans, gathers evidence, and writes findings into the knowledge graph.
      </p>

      <label className="rl-field">
        <span className="rl-field-label">Objective</span>
        <textarea
          ref={objRef}
          className="rl-field-input"
          rows={3}
          value={objective}
          onChange={(e) => setObjective(e.target.value)}
          placeholder="e.g. Determine how GGMN's quote routing works and what data it depends on"
        />
      </label>

      <label className="rl-field">
        <span className="rl-field-label">Success criteria <span className="rl-field-hint">one per line, optional</span></span>
        <textarea
          className="rl-field-input"
          rows={2}
          value={criteria}
          onChange={(e) => setCriteria(e.target.value)}
          placeholder="A verified claim about the routing path"
        />
      </label>

      <div className="rl-field-row">
        <label className="rl-field">
          <span className="rl-field-label">Domain <span className="rl-field-hint">optional</span></span>
          <input className="rl-field-input" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="e.g. defi" />
        </label>
        <label className="rl-field">
          <span className="rl-field-label">Agent</span>
          <select className="rl-field-input" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            <option value="">Default (server credentials)</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </label>
        <label className="rl-field rl-field-narrow">
          <span className="rl-field-label">Max iterations</span>
          <input
            className="rl-field-input"
            type="number"
            min={1}
            value={maxIter}
            onChange={(e) => setMaxIter(e.target.value)}
          />
        </label>
      </div>

      {stopOptions.length ? (
        <div className="rl-field">
          <span className="rl-field-label">Stop conditions <span className="rl-field-hint">default: diminishing-returns</span></span>
          <div className="rl-chips">
            {stopOptions.map((s) => {
              const on = stopping.includes(s);
              return (
                <button
                  key={s}
                  type="button"
                  className={`rl-chip ${on ? "is-on" : ""}`}
                  aria-pressed={on}
                  onClick={() => setStopping((prev) => (on ? prev.filter((x) => x !== s) : [...prev, s]))}
                >
                  {s}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {error ? <div className="rl-modal-err" role="alert">{error}</div> : null}

      <div className="rl-modal-actions">
        <button type="button" className="rl-btn" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="rl-btn rl-btn-primary" onClick={submit} disabled={busy || !objective.trim()}>
          {busy ? "Creating…" : "Create & monitor"}
        </button>
      </div>
    </Modal>
  );
}
