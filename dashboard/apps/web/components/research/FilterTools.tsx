"use client";

import type { ReactNode } from "react";
import type { FailureRow } from "@/lib/research-analytics";

/**
 * The shared control surface for the Timeline and Evaluations tabs: a filter
 * toolbar, an analytics strip, a distribution bar chart, a clickable failure
 * breakdown, and the filtered-vs-overall summary. Presentational only — every
 * number is passed in, computed from real data by `research-analytics`.
 */

/* ── filter toolbar ────────────────────────────────────────────────────────── */

export function FilterBar({
  activeCount,
  onClear,
  summary,
  children,
}: {
  activeCount: number;
  onClear: () => void;
  summary?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flt-bar">
      <div className="flt-row">{children}</div>
      <div className="flt-row-flush">
        {activeCount > 0 ? (
          <>
            <span className="flt-active">
              <span className="flt-active-n rl-mono">{activeCount}</span> filter{activeCount === 1 ? "" : "s"} active
            </span>
            <button type="button" className="flt-clear" onClick={onClear}>
              Clear filters
            </button>
          </>
        ) : (
          <span className="flt-idle">No filters</span>
        )}
        {summary ? <span className="flt-summary-slot">{summary}</span> : null}
      </div>
    </div>
  );
}

export function FilterSelect({
  label,
  value,
  onChange,
  options,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
}) {
  return (
    <label className="flt-field" data-active={value !== "ALL" || undefined}>
      <span className="flt-field-k">{label}</span>
      <select
        className="flt-select"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function FilterSearch({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="flt-field flt-field-grow" data-active={value.trim() ? true : undefined}>
      <span className="flt-field-k">Search</span>
      <input
        className="flt-input"
        type="search"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

/* ── analytics strip ───────────────────────────────────────────────────────── */

export interface Metric {
  k: string;
  v: ReactNode;
  tone?: "ok" | "warn" | "err" | "run" | "stop";
  title?: string;
}

/** A dense one-row metric strip (reuses the shared `.rl-stat` grid). */
export function MetricStrip({ cells }: { cells: Metric[] }) {
  return (
    <div className="rl-stats flt-metrics">
      {cells.map((c) => (
        <div className="rl-stat" key={c.k} title={c.title}>
          <div className="rl-stat-k">{c.k}</div>
          <div className="rl-stat-v" data-tone={c.tone}>
            {c.v}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── distribution bars ─────────────────────────────────────────────────────── */

export interface BarRow {
  key: string;
  label: string;
  count: number;
  pct: number; // 0..100
  tone?: "ok" | "warn" | "err" | "run" | "stop";
  onClick?: () => void;
  active?: boolean;
}

/** A lightweight, information-only outcome distribution (no chart library). */
export function DistributionBars({ rows, title }: { rows: BarRow[]; title?: string }) {
  const max = Math.max(1, ...rows.map((r) => r.pct));
  return (
    <div className="flt-dist">
      {title ? <div className="flt-dist-title">{title}</div> : null}
      {rows.map((r) => (
        <button
          type="button"
          key={r.key}
          className="flt-bar-row"
          data-tone={r.tone}
          data-active={r.active || undefined}
          onClick={r.onClick}
          disabled={!r.onClick || r.count === 0}
          title={r.onClick ? `Filter: ${r.label}` : undefined}
        >
          <span className="flt-bar-label">{r.label}</span>
          <span className="flt-bar-track">
            <span className="flt-bar-fill" style={{ width: `${(r.pct / max) * 100}%` }} />
          </span>
          <span className="flt-bar-val rl-mono">{r.pct.toFixed(1)}%</span>
          <span className="flt-bar-count rl-mono">{r.count.toLocaleString()}</span>
        </button>
      ))}
    </div>
  );
}

/* ── failure breakdown ─────────────────────────────────────────────────────── */

/** The engine's structured failure kinds, counted. With `onPick`, each row
 * clicks to filter; without it the breakdown is read-only. */
export function FailureBreakdown({
  rows,
  onPick,
  activeKind,
}: {
  rows: FailureRow[];
  onPick?: (kind: string) => void;
  activeKind?: string;
}) {
  if (!rows.length) return null;
  return (
    <div className="flt-breakdown">
      <div className="flt-dist-title">Failure breakdown</div>
      {rows.map((r) =>
        onPick ? (
          <button
            type="button"
            key={r.kind}
            className="flt-bd-row"
            data-active={activeKind === r.kind || undefined}
            onClick={() => onPick(r.kind)}
            title={`Filter to ${r.label}`}
          >
            <span className="flt-bd-label">{r.label}</span>
            <span className="flt-bd-count rl-mono">{r.count.toLocaleString()}</span>
          </button>
        ) : (
          <div className="flt-bd-row is-static" key={r.kind}>
            <span className="flt-bd-label">{r.label}</span>
            <span className="flt-bd-count rl-mono">{r.count.toLocaleString()}</span>
          </div>
        ),
      )}
    </div>
  );
}

/* ── filtered-vs-overall summary ───────────────────────────────────────────── */

export function FilteredSummary({
  shown,
  total,
  noun,
  chips,
  overall,
}: {
  shown: number;
  total: number;
  noun: string;
  chips: string[];
  overall?: { label: string; value: string };
}) {
  return (
    <div className="flt-filtered">
      <div className="flt-filtered-line">
        Showing <b className="rl-mono">{shown.toLocaleString()}</b> of{" "}
        <b className="rl-mono">{total.toLocaleString()}</b> {noun}
      </div>
      {chips.length ? (
        <div className="flt-chips">
          {chips.map((c, i) => (
            <span className="flt-chip" key={i}>
              {c}
            </span>
          ))}
        </div>
      ) : null}
      {overall ? (
        <div className="flt-overall rl-mono">
          {overall.label} <b>{overall.value}</b>
        </div>
      ) : null}
    </div>
  );
}

/* ── filtered empty state ──────────────────────────────────────────────────── */

export function FilteredEmpty({ noun, onClear }: { noun: string; onClear: () => void }) {
  return (
    <div className="flt-empty">
      <div className="flt-empty-title">No {noun} match these filters.</div>
      <button type="button" className="rl-btn" onClick={onClear}>
        Clear filters
      </button>
    </div>
  );
}
