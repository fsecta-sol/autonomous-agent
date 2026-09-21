"use client";

import type { TelemetryState } from "@dashboard/shared";

/** One cell in the agent telemetry strip. `sub` carries a secondary reading
 *  (e.g. a p95 under the median latency) without widening the cell. */
export interface TelemetryCell {
  k: string;
  v: string;
  tone: "ok" | "warn" | "err" | "muted";
  sub?: string;
}

const STATE_LABEL: Record<TelemetryState, string> = {
  working: "Working",
  live: "Live",
  idle: "Idle",
  stale: "Stale",
  offline: "Offline",
};

/** The status word an operator reads for a state. */
export function stateLabel(s: TelemetryState): string {
  return STATE_LABEL[s];
}

/**
 * The small live status lamp: a pulsing node while working, a steady dot when
 * live, a hollow one when idle, a warn/error mark when stale or offline. The
 * ring and dot are data marks, so circles are allowed here (the one shape the
 * design system reserves for information, not chrome).
 */
export function StatusLamp({ state }: { state: TelemetryState }) {
  return (
    <span className="ax-lamp" data-state={state} aria-hidden>
      {state === "working" ? <span className="ax-lamp-ring" /> : <span className="ax-lamp-dot" />}
    </span>
  );
}

/**
 * The agent telemetry strip: the measured readings an operator scans to know the
 * agent's health at a glance. It renders only the cells it is given — this
 * component never invents a value; the caller derives every figure from real
 * state and passes an honest "—" when a reading has no data yet.
 */
export function AgentTelemetryStrip({ cells }: { cells: TelemetryCell[] }) {
  return (
    <div className="ad-health" data-od-id="agent-health">
      {cells.map((c) => (
        <div className="ad-hcell" key={c.k}>
          <span className="k">{c.k}</span>
          <span className={`v ${c.tone}`}>{c.v}</span>
          {c.sub ? <span className="sub">{c.sub}</span> : null}
        </div>
      ))}
    </div>
  );
}
