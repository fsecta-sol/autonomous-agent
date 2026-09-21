"use client";

import { useMemo, useState } from "react";
import type { Evaluation, Iteration, ResearchResult, RunStatus, TraceStep } from "@/lib/research-loop";
import {
  classifyIteration,
  categoryLabel,
  computeRunAnalytics,
  failureKindToOutcome,
  failureLabel,
  iterationFailureKind,
  matchesTimeline,
  outcomeTone,
  OUTCOME_LABEL,
  OUTCOME_MARK,
  pct,
  presentCategories,
  presentDecisions,
  timelineFilterChips,
  timelineFilterCount,
  type IterationOutcome,
  type TimelineFilters,
} from "@/lib/research-analytics";
import {
  DistributionBars,
  FailureBreakdown,
  FilterBar,
  FilterSearch,
  FilterSelect,
  FilteredEmpty,
  FilteredSummary,
  MetricStrip,
  type BarRow,
} from "./FilterTools";
import { clock, formatDuration, stageLabel, StateNote, truncate } from "./shared";

const PAGE = 50;

/**
 * The Timeline: the run's iterations with a filter toolbar and failure analytics,
 * every number computed from the loaded iterations (never hardcoded). Failure
 * reasons are visible on the collapsed row, not buried behind expansion.
 */
export function TimelinePanel({
  iterations,
  status,
  results,
  iterationCount,
  filters,
  setFilters,
}: {
  iterations: Iteration[];
  status: RunStatus;
  results: ResearchResult[];
  iterationCount?: number;
  filters: TimelineFilters;
  setFilters: (f: TimelineFilters) => void;
}) {
  const [visible, setVisible] = useState(PAGE);

  // The dataset's own shape (not the filters') drives the run-wide analytics, so
  // the strip always reports the whole run and the summary reports the subset.
  const analytics = useMemo(() => computeRunAnalytics(iterations, status), [iterations, status]);
  const categories = useMemo(() => presentCategories(iterations), [iterations]);
  const decisions = useMemo(() => presentDecisions(iterations), [iterations]);

  const filtered = useMemo(
    () => iterations.filter((it) => matchesTimeline(it, filters, status)).sort((a, b) => b.index - a.index),
    [iterations, filters, status],
  );

  // Any filter change resets pagination — done in the handler, not an effect, so
  // a filter edit is one render rather than a cascading second one.
  const apply = (next: TimelineFilters) => {
    setFilters(next);
    setVisible(PAGE);
  };

  const byIteration = useMemo(() => new Map(results.map((r) => [r.iteration_id, r])), [results]);
  const activeCount = timelineFilterCount(filters);
  const truncated = iterationCount != null && iterationCount > iterations.length;

  if (!iterations.length) {
    return <StateNote kind="empty" title="No iterations yet." detail="The loop records an iteration once its first cycle runs." />;
  }

  const c = analytics.counts;
  const dist: BarRow[] = [
    { key: "SUCCESS", label: "Success", count: c.SUCCESS, pct: analytics.successPct, tone: "ok" },
    { key: "PARTIAL", label: "Partial", count: c.PARTIAL, pct: analytics.partialPct, tone: "warn" },
    { key: "FAILED", label: "Failed", count: c.FAILED, pct: pct(c.FAILED, analytics.evaluated), tone: "err" },
    { key: "TIMEOUT", label: "Timeout", count: c.TIMEOUT, pct: analytics.timeoutPct, tone: "err" },
  ];

  const setStatus = (s: IterationOutcome) => apply({ ...filters, status: filters.status === s ? "ALL" : s });

  return (
    <div className="rld-section">
      <MetricStrip
        cells={[
          { k: "Iterations", v: analytics.total.toLocaleString(), title: truncated ? `Showing the oldest ${iterations.length} of ${iterationCount}` : undefined },
          { k: "Evaluated", v: analytics.evaluated.toLocaleString(), title: "Finished iterations — the denominator for every rate" },
          { k: "Success", v: `${analytics.successPct.toFixed(1)}%`, tone: "ok" },
          { k: "Partial", v: `${analytics.partialPct.toFixed(1)}%`, tone: "warn" },
          { k: "Failed", v: `${analytics.failedPct.toFixed(1)}%`, tone: "err", title: "(Failed + Timed out) / evaluated" },
          { k: "Timeout", v: `${analytics.timeoutPct.toFixed(1)}%`, tone: "err" },
          { k: "Retried", v: `${analytics.retryPct.toFixed(1)}%`, tone: "warn", title: `${analytics.retried.toLocaleString()} iterations the loop chose to retry / evaluated (a separate axis — a retried iteration keeps its outcome)` },
        ]}
      />

      {truncated ? (
        <div className="flt-note">
          Showing the first {iterations.length.toLocaleString()} of {iterationCount!.toLocaleString()} iterations — the
          endpoint caps the list. Analytics cover the loaded iterations.
        </div>
      ) : null}

      <FilterBar
        activeCount={activeCount}
        onClear={() => apply({ status: "ALL", category: "ALL", decision: "ALL", retried: false, search: "" })}
      >
        <FilterSelect
          label="Status"
          value={filters.status}
          onChange={(v) => apply({ ...filters, status: v as TimelineFilters["status"] })}
          options={[
            { value: "ALL", label: "All" },
            ...(["SUCCESS", "PARTIAL", "FAILED", "TIMEOUT", "RUNNING", "PENDING"] as IterationOutcome[]).map((o) => ({
              value: o,
              label: OUTCOME_LABEL[o],
            })),
          ]}
        />
        <FilterSelect
          label="Category"
          value={filters.category}
          onChange={(v) => apply({ ...filters, category: v })}
          options={[{ value: "ALL", label: "All" }, ...categories.map((s) => ({ value: s, label: categoryLabel(s) }))]}
        />
        <FilterSelect
          label="Decision"
          value={filters.decision}
          onChange={(v) => apply({ ...filters, decision: v })}
          options={[{ value: "ALL", label: "All" }, ...decisions.map((d) => ({ value: d, label: d }))]}
        />
        <label className="flt-field flt-retried" data-active={filters.retried || undefined}>
          <span className="flt-field-k">Retry</span>
          <span className="flt-check">
            <input
              type="checkbox"
              checked={filters.retried}
              onChange={(e) => apply({ ...filters, retried: e.target.checked })}
            />
            <span>Retried only</span>
          </span>
        </label>
        <FilterSearch
          value={filters.search}
          onChange={(v) => apply({ ...filters, search: v })}
          placeholder="iteration # or hypothesis…"
        />
      </FilterBar>

      <div className="flt-analytics">
        <DistributionBars
          title="Outcome distribution"
          rows={dist.map((r) => ({ ...r, active: filters.status === r.key, onClick: () => setStatus(r.key as IterationOutcome) }))}
        />
        <FailureBreakdown
          rows={analytics.failureBreakdown}
          activeKind={
            filters.status === "TIMEOUT" ? "TIMEOUT" : filters.status === "FAILED" ? "FAILED" : undefined
          }
          onPick={(kind) => setStatus(failureKindToOutcome(kind))}
        />
      </div>

      {activeCount > 0 ? (
        <FilteredSummary
          shown={filtered.length}
          total={analytics.total}
          noun="iterations"
          chips={timelineFilterChips(filters)}
          overall={{ label: "Overall failure rate:", value: `${analytics.failedPct.toFixed(2)}%` }}
        />
      ) : null}

      {filtered.length === 0 ? (
        <FilteredEmpty noun="iterations" onClear={() => apply({ status: "ALL", category: "ALL", decision: "ALL", retried: false, search: "" })} />
      ) : (
        <>
          <ol className="rl-iter-list">
            {filtered.slice(0, visible).map((it) => (
              <IterationCard key={it.id} it={it} status={status} result={byIteration.get(it.id)} />
            ))}
          </ol>
          {filtered.length > visible ? (
            <button type="button" className="rl-btn flt-more" onClick={() => setVisible((v) => v + PAGE)}>
              Show {Math.min(PAGE, filtered.length - visible)} more · {filtered.length - visible} hidden
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}

/* ── iteration row ─────────────────────────────────────────────────────────── */

function IterationCard({
  it,
  status,
  result,
}: {
  it: Iteration;
  status: RunStatus;
  result?: ResearchResult;
}) {
  const [open, setOpen] = useState(false);
  const done = it.finished_at != null;
  const ev = (it.evaluation ?? {}) as Evaluation;
  const outcome = classifyIteration(it, status);
  const failureKind = iterationFailureKind(it);
  const tone = outcomeTone(outcome);
  const duration = done ? formatDuration((it.finished_at! - it.started_at) / 1000) : outcome === "RUNNING" ? "running" : "—";
  // The sub-agent's own failure reason — never the loop's next-action reason,
  // which describes a decision, not the failure.
  const reason = result?.failure_reason || "";
  const { text: hypSnippet, full: hypFull } = truncate(it.hypothesis || "", 150);

  return (
    <li className="rl-iter" data-outcome={outcome}>
      <button type="button" className="rl-iter-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="rl-iter-mark" data-tone={tone} aria-hidden>
          {OUTCOME_MARK[outcome]}
        </span>
        <span className="rl-iter-title">Iteration {it.index}</span>
        {it.strategy ? <span className="rl-iter-cat">{categoryLabel(it.strategy)}</span> : null}
        <span className="rl-iter-outcome" data-tone={tone}>
          {OUTCOME_LABEL[outcome]}
        </span>
        {it.next_action ? <span className="rl-iter-decision rl-mono">→ {it.next_action}</span> : null}
        <span className="rl-iter-time rl-mono">{duration}</span>
        <span className="rl-iter-chev" aria-hidden>{open ? "▾" : "▸"}</span>
      </button>

      {/* Failure reason is visible without expansion — the operator's first question. */}
      {failureKind ? (
        <div className="rl-iter-fail">
          <span className="rl-fail-kind rl-mono" data-kind={failureKind}>
            {failureLabel(failureKind)}
          </span>
          {reason ? <span className="rl-fail-reason">{reason}</span> : null}
        </div>
      ) : null}

      {/* A one-line hypothesis keeps the row scannable without expanding. */}
      {hypSnippet ? (
        <div className="rl-iter-hyp" title={hypFull}>
          {hypSnippet}
        </div>
      ) : null}

      {open ? (
        <div className="rl-iter-body">
          <div className="rl-iter-sub">
            {it.branch && it.branch !== "main" ? <span className="rl-tag">branch {it.branch}</span> : null}
            <span className="rl-tag">{stageLabel(it.stage)}</span>
            {it.disposition ? <span className="rl-tag" data-op={it.disposition.toLowerCase()}>{it.disposition}</span> : null}
          </div>
          {it.hypothesis ? (
            <div className="rl-kv">
              <span className="rl-kv-k">Hypothesis</span>
              <span className="rl-kv-v" title={hypFull}>{it.hypothesis}</span>
            </div>
          ) : null}
          <div className="rl-kv">
            <span className="rl-kv-k">Evaluation</span>
            <span className="rl-kv-v">
              {ev.answered_question != null || ev.info_gain != null ? (
                <>
                  info gain {fmtNum(ev.info_gain)}
                  {ev.new_evidence ? " · new evidence" : ""}
                  {ev.uncertainty_reduced ? " · uncertainty reduced" : ""}
                  {ev.contradiction_created ? " · contradiction" : ""}
                  {ev.hypothesis_survived === false ? " · hypothesis rejected" : ""}
                  {ev.failed ? ` · failed${ev.failure_kind ? ` (${ev.failure_kind})` : ""}` : ""}
                </>
              ) : (
                <span className="rl-muted">not evaluated yet</span>
              )}
            </span>
          </div>
          {it.next_reason ? (
            <div className="rl-kv">
              <span className="rl-kv-k">Decision</span>
              <span className="rl-kv-v">{it.next_reason}</span>
            </div>
          ) : null}
          <div className="rl-kv">
            <span className="rl-kv-k">Knowledge</span>
            <span className="rl-kv-v">
              {it.knowledge_updates.length ? (
                <ul className="rl-mut-list">
                  {it.knowledge_updates.map((u, i) => (
                    <li key={i} className="rl-mut" data-op={(u.op || "").toLowerCase()}>
                      <span className="rl-mut-op">{u.op}</span>
                      {u.id ? <span className="rl-mut-id">[[{u.id}]]</span> : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <span className="rl-muted">no knowledge changes</span>
              )}
            </span>
          </div>
          <div className="rl-kv">
            <span className="rl-kv-k">Timing</span>
            <span className="rl-kv-v rl-mono">
              {clock(it.started_at)} → {it.finished_at ? clock(it.finished_at) : "…"}
            </span>
          </div>
          {result ? <ResultSections result={result} /> : null}
        </div>
      ) : null}
    </li>
  );
}

/* ── the sub-agent's work: result + activity trace ────────────────────────── */

/**
 * The executed result of one iteration and the sub-agent's observable activity
 * trace. Everything shown is the engine's own persisted output — the evidence the
 * sub-agent returned and the steps it took to get there. This is the observable
 * activity, not a private chain-of-thought: it is what the run did.
 */
function ResultSections({ result }: { result: ResearchResult }) {
  const cost = result.cost ?? {};
  const hasFindings =
    result.observations.length || result.evidence.length || result.conclusions.length || result.uncertainties.length;
  return (
    <>
      {result.trace.length ? <ActivityTrace steps={result.trace} /> : null}

      {hasFindings ? (
        <div className="rl-kv rl-kv-block">
          <span className="rl-kv-k">Findings</span>
          <span className="rl-kv-v">
            <div className="result-secs">
              <ResultList title={`Observations (${result.observations.length})`} items={result.observations.map((o) => ({ text: o.statement || "" }))} />
              <ResultList title={`Evidence (${result.evidence.length})`} items={result.evidence.map((e) => ({ text: e.statement || "", tag: e.kind || "" }))} />
              <ResultList title={`Conclusions (${result.conclusions.length})`} items={result.conclusions.map((text) => ({ text }))} />
              <ResultList title={`Uncertainties (${result.uncertainties.length})`} items={result.uncertainties.map((text) => ({ text }))} />
            </div>
          </span>
        </div>
      ) : null}

      {result.sources.length ? (
        <div className="rl-kv rl-kv-block">
          <span className="rl-kv-k">Sources</span>
          <span className="rl-kv-v">
            <ul className="result-sources">
              {result.sources.slice(0, 20).map((s, i) => (
                <li key={i} className="rl-mono" title={s}>
                  {s}
                </li>
              ))}
            </ul>
          </span>
        </div>
      ) : null}

      {result.failure_kind ? (
        <div className="rl-kv">
          <span className="rl-kv-k">Failure</span>
          <span className="rl-kv-v">
            <span className="result-failure" data-kind={result.failure_kind}>
              {result.failure_kind}
            </span>
            {result.failure_reason ? <span className="rl-muted"> {result.failure_reason}</span> : null}
          </span>
        </div>
      ) : null}

      {cost.seconds != null || cost.tool_calls != null ? (
        <div className="rl-kv">
          <span className="rl-kv-k">Cost</span>
          <span className="rl-kv-v rl-mono">
            {cost.seconds != null ? `${formatDuration(cost.seconds)}` : "—"}
            {cost.tool_calls != null ? ` · ${cost.tool_calls} tool calls` : ""}
          </span>
        </div>
      ) : null}
    </>
  );
}

function ResultList({ title, items }: { title: string; items: Array<{ text: string; tag?: string }> }) {
  const clean = items.filter((it) => (it.text || "").trim());
  if (!clean.length) return null;
  return (
    <div className="result-sec">
      <div className="result-sec-title">{title}</div>
      <ul className="result-list">
        {clean.map((it, i) => (
          <li key={i}>
            {it.tag ? <span className="result-tag rl-mono">{it.tag}</span> : null}
            {it.text}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One trace step, in the sub-agent's own message order. */
function ActivityTrace({ steps }: { steps: TraceStep[] }) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? steps : steps.slice(0, 12);
  return (
    <div className="rl-kv rl-kv-block">
      <span className="rl-kv-k">Sub-agent activity</span>
      <span className="rl-kv-v">
        <ol className="trace-list">
          {shown.map((s, i) => (
            <li key={i} className="trace-step" data-kind={s.kind}>
              <span className="trace-kind rl-mono">{TRACE_LABEL[s.kind] ?? s.kind}</span>
              {s.name ? <span className="trace-name rl-mono">{s.name}</span> : null}
              {s.kind === "tool_call" && s.args ? (
                <span className="trace-text rl-mono" title={s.args}>
                  {s.args}
                </span>
              ) : (
                <span className="trace-text" title={s.text}>
                  {s.text}
                </span>
              )}
            </li>
          ))}
        </ol>
        {steps.length > 12 ? (
          <button type="button" className="rl-btn rl-btn-sm trace-more" onClick={() => setShowAll((v) => !v)}>
            {showAll ? "Show fewer" : `Show all ${steps.length} steps`}
          </button>
        ) : null}
      </span>
    </div>
  );
}

const TRACE_LABEL: Record<string, string> = {
  thought: "think",
  tool_call: "call",
  tool_result: "result",
};

function fmtNum(n: number | undefined): string {
  if (n == null) return "—";
  return Number.isInteger(n) ? String(n) : n.toFixed(3);
}
