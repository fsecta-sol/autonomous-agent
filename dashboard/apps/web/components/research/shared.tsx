"use client";

import type { ReactNode } from "react";
import type { RunStatus, RunStage } from "@/lib/research-loop";

/** The operator-facing label for a run status (backend value → display). */
export const STATUS_LABEL: Record<RunStatus, string> = {
  PENDING: "Queued",
  RUNNING: "Running",
  PAUSED: "Paused",
  WAITING: "Waiting",
  BLOCKED: "Blocked",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
  FAILED: "Failed",
};

/** The CSS tone a status maps to (`data-tone` on the badge). */
export type Tone = "run" | "wait" | "ok" | "stop" | "err";

export function statusTone(status: RunStatus): Tone {
  switch (status) {
    case "RUNNING":
      return "run";
    case "PENDING":
    case "PAUSED":
    case "WAITING":
    case "BLOCKED":
      return "wait";
    case "COMPLETED":
      return "ok";
    case "CANCELLED":
      return "stop";
    case "FAILED":
      return "err";
  }
}

export function isTerminal(status: RunStatus): boolean {
  return status === "COMPLETED" || status === "CANCELLED" || status === "FAILED";
}

/** Human-readable stage (backend SCREAMING_SNAKE → spaced Title). */
export function stageLabel(stage: RunStage | string): string {
  return String(stage)
    .toLowerCase()
    .split("_")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/** "1h 04m" · "3m 12s" · "0.8s" from a seconds count. */
export function formatDuration(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 1) return `${(seconds * 1000).toFixed(0)}ms`;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  if (m < 60) return `${m}m ${String(s).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

/** A coarse "3m ago" from an epoch-ms stamp. */
export function relativeTime(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** "14:03:07" local clock from an epoch-ms stamp. */
export function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour12: false });
}

/** A status badge. */
export function StatusBadge({ status, live }: { status: RunStatus; live?: boolean }) {
  return (
    <span className="rl-badge" data-tone={statusTone(status)}>
      {live ? <span className="rl-live-dot" aria-hidden /> : null}
      {STATUS_LABEL[status]}
    </span>
  );
}

/**
 * The loading / empty / error / disconnected note every async panel shares.
 * A failure is never rendered as empty data — `kind="error"` is distinct.
 */
export function StateNote({
  kind,
  title,
  detail,
  onRetry,
}: {
  kind: "loading" | "empty" | "error" | "info";
  title: string;
  detail?: string;
  onRetry?: () => void;
}) {
  return (
    <div className={`rl-state rl-state-${kind}`} role={kind === "error" ? "alert" : "status"}>
      {kind === "loading" ? <span className="rl-spin" aria-hidden /> : null}
      <div className="rl-state-text">
        <div className="rl-state-title">{title}</div>
        {detail ? <div className="rl-state-detail">{detail}</div> : null}
      </div>
      {kind === "error" && onRetry ? (
        <button type="button" className="rl-btn" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}

/** A compact key/value stat cell for dense operator rows. */
export function Stat({ k, v, title }: { k: string; v: ReactNode; title?: string }) {
  return (
    <div className="rl-stat" title={title}>
      <div className="rl-stat-k">{k}</div>
      <div className="rl-stat-v">{v}</div>
    </div>
  );
}

/** Truncate a string for a dense one-line row, with a title tooltip for the full text. */
export function truncate(text: string, max = 140): { text: string; full: string } {
  const full = text ?? "";
  return { text: full.length > max ? full.slice(0, max).trimEnd() + "…" : full, full };
}
