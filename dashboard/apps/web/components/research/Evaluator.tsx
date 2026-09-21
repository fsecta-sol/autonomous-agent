"use client";

import { useMemo, useState } from "react";
import {
  getEvaluation,
  type EvaluationContradiction,
  type EvaluationDiscovery,
  type EvaluationFailure,
  type EvaluationSignal,
  type EvidenceAssessment,
  type Iteration,
  type Recommendation,
  type ResearchEvaluation,
  type ResearchEvaluationLean,
} from "@/lib/research-loop";
import {
  computeEvaluationAnalytics,
  CONFIDENCE_HIGH,
  CONFIDENCE_MEDIUM,
  DIMENSION_LABEL,
  evaluationFilterChips,
  evaluationFilterCount,
  matchesEvaluation,
  NUMERIC_DIMENSIONS,
  pct,
  type ConfidenceBand,
  type EvaluationFilters,
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
import { StateNote, clock } from "./shared";

const PAGE = 50;

/** The Evaluator's status → display tone. */
const STATUS_TONE: Record<string, "ok" | "warn" | "stop" | "err"> = {
  SUCCESS: "ok",
  PARTIAL_SUCCESS: "ok",
  NO_PROGRESS: "warn",
  BLOCKED: "stop",
  FAILED: "err",
};

const STATUS_LABEL: Record<string, string> = {
  SUCCESS: "Success",
  PARTIAL_SUCCESS: "Partial",
  NO_PROGRESS: "No progress",
  BLOCKED: "Blocked",
  FAILED: "Failed",
};

/** The ten dimensions, in the engine's order, with operator-facing labels. */
const DIMENSIONS: Array<{ key: keyof ResearchEvaluationLean; label: string }> = [
  { key: "result_quality", label: "Result quality" },
  { key: "evidence_quality", label: "Evidence quality" },
  { key: "source_quality", label: "Source quality" },
  { key: "relevance", label: "Relevance" },
  { key: "completeness", label: "Completeness" },
  { key: "novelty", label: "Novelty" },
  { key: "knowledge_gain", label: "Knowledge gain" },
  { key: "uncertainty_reduction", label: "Uncertainty cut" },
  { key: "objective_progress", label: "Objective progress" },
  { key: "confidence", label: "Confidence" },
];

/**
 * The Research Evaluator's records for a run — one decision-support record per
 * iteration. Loaded lean (scalars + counts) so a run with thousands of
 * iterations filters and charts in one response; each card's heavy detail
 * (evidence, unknowns, reasoning) is fetched on demand when it is expanded.
 * Every number is the evaluator's own output; nothing is computed here beyond
 * the filter analytics, which are derived from the records themselves.
 */
export function EvaluationsPanel({
  evaluations,
  load,
  error,
  iterations,
  filters,
  setFilters,
  onRetry,
}: {
  evaluations: ResearchEvaluationLean[];
  load: "loading" | "ready" | "error";
  error: string;
  iterations: Iteration[];
  filters: EvaluationFilters;
  setFilters: (f: EvaluationFilters) => void;
  onRetry: () => void;
}) {
  const [visible, setVisible] = useState(PAGE);

  const analytics = useMemo(() => computeEvaluationAnalytics(evaluations), [evaluations]);
  const filtered = useMemo(
    () =>
      evaluations
        .filter((ev) => matchesEvaluation(ev, filters))
        .sort((a, b) => b.created_at - a.created_at),
    [evaluations, filters],
  );

  // Reset pagination in the handler, not an effect, so a filter change is a
  // single render rather than a cascading second one.
  const apply = (next: EvaluationFilters) => {
    setFilters(next);
    setVisible(PAGE);
  };
  const clear = () => apply({ status: "ALL", confidence: "ALL", numeric: [], search: "" });

  if (load === "loading" && !evaluations.length) {
    return <StateNote kind="loading" title="Loading evaluations…" />;
  }
  if (load === "error" && !evaluations.length) {
    return <StateNote kind="error" title="Unable to load evaluations." detail={error} onRetry={onRetry} />;
  }
  if (!evaluations.length) {
    return (
      <StateNote
        kind="empty"
        title="No evaluations yet."
        detail="The evaluator records a decision-support entry after each iteration reaches its analysis stage."
      />
    );
  }

  const indexOf = new Map(iterations.map((it) => [it.id, it.index]));
  const activeCount = evaluationFilterCount(filters);
  const sc = analytics.statusCounts;

  const dist: BarRow[] = [
    { key: "SUCCESS", label: "Success", count: sc.SUCCESS ?? 0, pct: analytics.passedPct, tone: "ok" },
    { key: "PARTIAL_SUCCESS", label: "Partial", count: sc.PARTIAL_SUCCESS ?? 0, pct: analytics.partialPct, tone: "warn" },
    { key: "NO_PROGRESS", label: "No progress", count: sc.NO_PROGRESS ?? 0, pct: pct(sc.NO_PROGRESS ?? 0, analytics.total), tone: "warn" },
    { key: "FAILED", label: "Failed", count: sc.FAILED ?? 0, pct: analytics.failedPct, tone: "err" },
    { key: "BLOCKED", label: "Blocked", count: sc.BLOCKED ?? 0, pct: analytics.blockedPct, tone: "stop" },
  ];

  return (
    <div className="rld-section">
      <div className="eval-intro">
        Each record is the evaluator’s decision-support output for one iteration — dimensions,
        evidence grades, contradictions, signals and the recommendation it handed to the loop.
      </div>

      <MetricStrip
        cells={[
          { k: "Evaluations", v: analytics.total.toLocaleString() },
          { k: "Passed", v: `${analytics.passedPct.toFixed(1)}%`, tone: "ok" },
          { k: "Partial", v: `${analytics.partialPct.toFixed(1)}%`, tone: "warn" },
          { k: "Failed", v: `${analytics.failedPct.toFixed(1)}%`, tone: "err" },
          { k: "Rec. retry", v: `${analytics.retryPct.toFixed(1)}%`, tone: "warn", title: "Records whose recommendation action is RETRY — the evaluator's advice, which the loop may overrule (compare the Timeline's Retried rate)" },
          { k: "Avg confidence", v: analytics.avgConfidence.toFixed(2), title: "Mean of the confidence dimension" },
          { k: "Avg knowledge gain", v: analytics.avgKnowledgeGain.toFixed(2) },
        ]}
      />

      <FilterBar activeCount={activeCount} onClear={clear}>
        <FilterSelect
          label="Status"
          value={filters.status}
          onChange={(v) => apply({ ...filters, status: v })}
          options={[
            { value: "ALL", label: "All" },
            { value: "SUCCESS", label: "Passed" },
            { value: "PARTIAL_SUCCESS", label: "Partial" },
            { value: "NO_PROGRESS", label: "No progress" },
            { value: "FAILED", label: "Failed" },
            { value: "BLOCKED", label: "Blocked" },
            { value: "RETRY", label: "Retry (recommendation)" },
          ]}
        />
        <FilterSelect
          label="Confidence"
          value={filters.confidence}
          onChange={(v) => apply({ ...filters, confidence: v as ConfidenceBand | "ALL" })}
          options={[
            { value: "ALL", label: "All" },
            { value: "high", label: `High (≥ ${CONFIDENCE_HIGH.toFixed(2)})` },
            { value: "medium", label: `Medium (${CONFIDENCE_MEDIUM.toFixed(2)}–${CONFIDENCE_HIGH.toFixed(2)})` },
            { value: "low", label: `Low (< ${CONFIDENCE_MEDIUM.toFixed(2)})` },
          ]}
        />
        <AdvancedFilters filters={filters} setFilters={apply} />
        <FilterSearch value={filters.search} onChange={(v) => apply({ ...filters, search: v })} placeholder="strategy or iteration id…" />
      </FilterBar>

      <div className="flt-analytics">
        <DistributionBars
          title="Status distribution"
          rows={dist.map((r) => ({
            ...r,
            active: filters.status === r.key,
            onClick: () => apply({ ...filters, status: filters.status === r.key ? "ALL" : r.key }),
          }))}
        />
        {analytics.failureBreakdown.length ? <FailureBreakdown rows={analytics.failureBreakdown} /> : null}
      </div>

      {activeCount > 0 ? (
        <FilteredSummary
          shown={filtered.length}
          total={analytics.total}
          noun="evaluations"
          chips={evaluationFilterChips(filters)}
          overall={{ label: "Overall failed rate:", value: `${analytics.failedPct.toFixed(2)}%` }}
        />
      ) : null}

      {filtered.length === 0 ? (
        <FilteredEmpty noun="evaluations" onClear={clear} />
      ) : (
        <>
          <div className="eval-list">
            {filtered.slice(0, visible).map((ev) => (
              <EvaluationCard key={ev.id} ev={ev} iterationIndex={indexOf.get(ev.iteration_id)} />
            ))}
          </div>
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

/* ── advanced numeric filters (popover) ────────────────────────────────────── */

function AdvancedFilters({
  filters,
  setFilters,
}: {
  filters: EvaluationFilters;
  setFilters: (f: EvaluationFilters) => void;
}) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState<string>("confidence");
  const [op, setOp] = useState<">=" | "<=">(">=");
  const [value, setValue] = useState<string>("0.80");

  const add = () => {
    const v = parseFloat(value);
    if (!isFinite(v)) return;
    setFilters({ ...filters, numeric: [...filters.numeric, { key, op, value: v }] });
    setOpen(false);
  };

  return (
    <div className="flt-adv">
      <button
        type="button"
        className="flt-adv-btn"
        data-active={filters.numeric.length ? true : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        Metrics{filters.numeric.length ? ` (${filters.numeric.length})` : ""} ▾
      </button>
      {open ? (
        <div className="flt-adv-pop">
          <div className="flt-adv-add">
            <select className="flt-select" value={key} onChange={(e) => setKey(e.target.value)}>
              {NUMERIC_DIMENSIONS.map((d) => (
                <option key={d} value={d}>
                  {DIMENSION_LABEL[d]}
                </option>
              ))}
            </select>
            <select className="flt-select flt-select-sm" value={op} onChange={(e) => setOp(e.target.value as ">=" | "<=")}>
              <option value=">=">≥</option>
              <option value="<=">≤</option>
            </select>
            <input
              className="flt-input flt-input-num"
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && add()}
            />
            <button type="button" className="rl-btn rl-btn-sm" onClick={add}>
              Add
            </button>
          </div>
          {filters.numeric.length ? (
            <ul className="flt-adv-list">
              {filters.numeric.map((n, i) => (
                <li key={i} className="flt-adv-item">
                  <span className="rl-mono">
                    {DIMENSION_LABEL[n.key] ?? n.key} {n.op} {n.value}
                  </span>
                  <button
                    type="button"
                    className="flt-adv-x"
                    aria-label="remove"
                    onClick={() => setFilters({ ...filters, numeric: filters.numeric.filter((_, j) => j !== i) })}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="flt-adv-hint">e.g. Confidence ≥ 0.80 · Knowledge gain ≥ 0.50</div>
          )}
        </div>
      ) : null}
    </div>
  );
}

/* ── evaluation card ───────────────────────────────────────────────────────── */

function EvaluationCard({ ev, iterationIndex }: { ev: ResearchEvaluationLean; iterationIndex?: number }) {
  const [open, setOpen] = useState(false);
  // The heavy arrays (evidence, unknowns, reasoning…) are not in the lean list —
  // they are fetched the first time the card is expanded.
  const [full, setFull] = useState<ResearchEvaluation | null>(null);
  const [fullState, setFullState] = useState<"idle" | "loading" | "error">("idle");

  const rec = hasKeys(ev.recommendation) ? (ev.recommendation as Recommendation) : null;
  const counts = {
    evidence: ev.n_evidence,
    contradictions: ev.n_contradictions,
    discoveries: ev.n_discoveries,
    unknowns: ev.n_unknowns,
  };
  const firstFailure = ev.failures?.[0];

  // The heavy arrays are fetched the first time the card is expanded — the fetch
  // is kicked off by the expand action itself, not an effect.
  const loadFull = () => {
    if (full || fullState === "loading") return;
    setFullState("loading");
    getEvaluation(ev.id)
      .then((r) => {
        setFull(r.evaluation);
        setFullState("idle");
      })
      .catch(() => setFullState("error"));
  };
  const toggle = () => {
    if (!open) loadFull();
    setOpen((v) => !v);
  };

  const reasoning = full && hasKeys(full.reasoning) ? full.reasoning : null;

  return (
    <article className={`eval-card ${open ? "is-open" : ""}`} data-status={ev.status}>
      <button type="button" className="eval-card-head" onClick={toggle} aria-expanded={open}>
        <span className="eval-caret" aria-hidden>
          {open ? "▾" : "▸"}
        </span>
        <span className="eval-card-title">
          Iteration {iterationIndex ?? "—"}
          <span className="eval-strategy">{ev.strategy || "—"}</span>
        </span>
        <span className="eval-badge" data-tone={STATUS_TONE[ev.status] ?? "warn"}>
          {STATUS_LABEL[ev.status] ?? ev.status}
        </span>
        {rec && rec.action ? <span className="eval-rec-inline rl-mono">→ {rec.action}</span> : null}
        <span className="eval-card-time rl-mono">{clock(ev.created_at)}</span>
      </button>

      {/* The failure reason is visible on the collapsed card — the operator's why. */}
      {firstFailure ? (
        <div className="eval-fail-inline">
          <span className="rl-fail-kind rl-mono" data-kind={firstFailure.kind}>
            {firstFailure.kind}
          </span>
          {firstFailure.reason ? <span className="eval-fail-inline-reason">{firstFailure.reason}</span> : null}
          {firstFailure.retryable ? <span className="eval-fail-retry">retryable</span> : null}
        </div>
      ) : null}

      {/* The dimension strip is always visible — the fastest read of the verdict. */}
      <div className="eval-dims">
        {DIMENSIONS.map((d) => {
          const v = Number(ev[d.key] ?? 0);
          return (
            <div className="eval-dim" key={d.key} title={`${d.label}: ${v.toFixed(3)}`}>
              <span className="eval-dim-k">{d.label}</span>
              <span className="eval-dim-track">
                <span className="eval-dim-fill" style={{ width: `${Math.max(0, Math.min(1, v)) * 100}%` }} />
              </span>
              <span className="eval-dim-v rl-mono">{v.toFixed(2)}</span>
            </div>
          );
        })}
      </div>

      {/* The recommendation is the causal link into the loop — surface it closed too. */}
      {rec && rec.action ? (
        <div className="eval-rec">
          <span className="eval-rec-action">{rec.action}</span>
          {rec.reason ? <span className="eval-rec-reason">{rec.reason}</span> : null}
          {rec.confidence ? <span className="eval-rec-conf rl-mono">conf {rec.confidence.toFixed(2)}</span> : null}
          {rec.suggested_strategy ? <span className="eval-rec-hint rl-mono">strategy → {rec.suggested_strategy}</span> : null}
          {rec.suggested_focus ? <span className="eval-rec-hint rl-mono">focus → {rec.suggested_focus}</span> : null}
        </div>
      ) : null}

      <div className="eval-counts">
        <Count n={counts.evidence} label="evidence" />
        <Count n={counts.contradictions} label="contradictions" tone={counts.contradictions ? "err" : undefined} />
        <Count n={counts.discoveries} label="discoveries" />
        <Count n={counts.unknowns} label="unknowns" tone={counts.unknowns ? "warn" : undefined} />
        <Count n={ev.failures.length} label="failures" tone={ev.failures.length ? "err" : undefined} />
        {ev.llm_assisted ? <span className="eval-flag">llm-assisted</span> : null}
      </div>

      {open ? (
        <div className="eval-body">
          {ev.signals.length ? (
            <Section title="Signals">
              <div className="eval-signals">
                {ev.signals.map((s, i) => (
                  <SignalChip key={`${s.name}-${i}`} s={s} />
                ))}
              </div>
            </Section>
          ) : null}

          {fullState === "loading" ? <div className="eval-loading rl-muted">Loading full details…</div> : null}
          {fullState === "error" ? <div className="eval-loading rl-muted">Could not load full details.</div> : null}

          {reasoning && (reasoning.summary || reasoning.steps?.length) ? (
            <Section title="Reasoning">
              {reasoning.summary ? <p className="eval-text">{reasoning.summary}</p> : null}
              {reasoning.steps?.length ? (
                <ol className="eval-steps">
                  {reasoning.steps.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ol>
              ) : null}
            </Section>
          ) : null}

          {full && full.evidence_assessments.length ? (
            <Section title={`Evidence (${full.evidence_assessments.length})`}>
              <div className="eval-evidence">
                {full.evidence_assessments.slice(0, 40).map((a, i) => (
                  <EvidenceRow key={a.evidence_id || i} a={a} />
                ))}
              </div>
            </Section>
          ) : null}

          {full && full.contradictions.length ? (
            <Section title={`Contradictions (${full.contradictions.length})`}>
              {full.contradictions.map((c) => (
                <ContradictionRow key={c.id} c={c} />
              ))}
            </Section>
          ) : null}

          {full && full.discoveries.length ? (
            <Section title={`Discoveries (${full.discoveries.length})`}>
              {full.discoveries.map((d) => (
                <DiscoveryRow key={d.id} d={d} />
              ))}
            </Section>
          ) : null}

          {full && full.unresolved_unknowns.length ? (
            <Section title={`Unresolved unknowns (${full.unresolved_unknowns.length})`}>
              {full.unresolved_unknowns.map((u) => (
                <div className="eval-unknown" key={u.id}>
                  <span className="eval-sev" data-sev={u.severity}>
                    {u.severity}
                  </span>
                  <span className="eval-unknown-q">{u.question}</span>
                  <span className="eval-unknown-src rl-mono">{u.source}</span>
                </div>
              ))}
            </Section>
          ) : null}

          {ev.failures.length ? (
            <Section title={`Failures (${ev.failures.length})`}>
              {ev.failures.map((f, i) => (
                <FailureRow key={i} f={f} />
              ))}
            </Section>
          ) : null}

          {full && full.answered_questions.length ? (
            <Section title={`Answered (${full.answered_questions.length})`}>
              <ul className="eval-questions">
                {full.answered_questions.map((q, i) => (
                  <li key={i}>{q}</li>
                ))}
              </ul>
            </Section>
          ) : null}
          {full && full.unanswered_questions.length ? (
            <Section title={`Unanswered (${full.unanswered_questions.length})`}>
              <ul className="eval-questions">
                {full.unanswered_questions.map((q, i) => (
                  <li key={i}>{q}</li>
                ))}
              </ul>
            </Section>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="eval-sec">
      <div className="eval-sec-title">{title}</div>
      {children}
    </div>
  );
}

function Count({ n, label, tone }: { n: number; label: string; tone?: "warn" | "err" }) {
  if (!n) return <span className="eval-count is-zero">{label} 0</span>;
  return (
    <span className="eval-count" data-tone={tone}>
      {label} {n}
    </span>
  );
}

function SignalChip({ s }: { s: EvaluationSignal }) {
  return (
    <span className="eval-signal" data-dir={s.direction} title={s.reason}>
      <span className="eval-signal-name">{s.name}</span>
      {s.weight ? <span className="eval-signal-w rl-mono">{s.weight.toFixed(2)}</span> : null}
    </span>
  );
}

function EvidenceRow({ a }: { a: EvidenceAssessment }) {
  return (
    <div className="eval-ev">
      <span className="eval-ev-strength rl-mono" data-strength={a.strength}>
        {a.strength}
      </span>
      <span className="eval-ev-level rl-mono">{a.level}</span>
      <span className="eval-ev-stmt" title={a.rationale || a.statement}>
        {a.statement || a.rationale || a.evidence_id}
      </span>
      {a.source ? <span className="eval-ev-src rl-mono">{a.source}</span> : null}
    </div>
  );
}

function ContradictionRow({ c }: { c: EvaluationContradiction }) {
  return (
    <div className="eval-contra">
      <span className="eval-sev" data-sev={c.severity}>
        {c.severity}
      </span>
      <span className="eval-contra-body">
        <span className="eval-contra-claim">{c.claim || c.subject}</span>
        {c.conflicts_with ? <span className="eval-contra-vs rl-mono">conflicts with {c.conflicts_with}</span> : null}
      </span>
      <span className="eval-contra-state rl-mono" data-resolved={c.resolved}>
        {c.resolved ? "resolved" : "open"}
      </span>
    </div>
  );
}

function DiscoveryRow({ d }: { d: EvaluationDiscovery }) {
  return (
    <div className="eval-discovery">
      <span className="eval-disc-kind rl-mono">{d.kind}</span>
      <span className="eval-disc-stmt">{d.statement}</span>
      <span className="eval-disc-conf rl-mono">{d.confidence.toFixed(2)}</span>
    </div>
  );
}

function FailureRow({ f }: { f: EvaluationFailure }) {
  return (
    <div className="eval-failure">
      <span className="eval-fail-kind rl-mono">{f.kind}</span>
      <span className="eval-fail-reason">{f.reason}</span>
      {f.retryable ? <span className="eval-fail-retry">retryable</span> : null}
      {f.attempts ? <span className="eval-fail-att rl-mono">×{f.attempts}</span> : null}
    </div>
  );
}

function hasKeys(o: unknown): boolean {
  return !!o && typeof o === "object" && Object.keys(o as object).length > 0;
}
