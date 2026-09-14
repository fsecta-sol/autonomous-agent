"use client";

import type { SpawnEvent } from "@/lib/api";

const STATUS_CLASS: Record<SpawnEvent["status"], string> = {
  running: "is-running",
  done: "is-done",
  timed_out: "is-warn",
  error: "is-error",
};

function duration(s: SpawnEvent): string {
  if (s.startedAt === undefined) return "—";
  const end = s.finishedAt ?? (s.status === "running" ? Date.now() : s.startedAt);
  const secs = Math.max(0, Math.round((end - s.startedAt) / 1000));
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  return `${m}m ${secs % 60}s`;
}

/**
 * The spawn tree of one orchestrator run: the orchestrator at the root, each
 * sub-agent it delegated to as a child. This is a trace of delegation, not a
 * dependency graph — sub-agents are spawned in the order the model chose.
 */
export function SpawnTree({
  rootLabel,
  spawns,
  selectedId,
  onSelect,
}: {
  rootLabel: string;
  spawns: SpawnEvent[];
  selectedId: string | null;
  onSelect: (s: SpawnEvent) => void;
}) {
  return (
    <div className="spawn-tree" data-od-id="spawn-tree">
      <div className="st-root">
        <span className="st-dot is-root" />
        <span className="st-root-label">{rootLabel}</span>
        <span className="st-count">{spawns.length} sub-agent{spawns.length === 1 ? "" : "s"}</span>
      </div>
      {spawns.length ? (
        <ul className="st-children">
          {spawns.map((s) => (
            <li key={s.id ?? `${s.role}-${s.goal.slice(0, 12)}`}>
              <button
                type="button"
                className={`st-node ${STATUS_CLASS[s.status]} ${selectedId === s.id ? "is-sel" : ""}`}
                onClick={() => onSelect(s)}
              >
                <span className={`st-dot ${STATUS_CLASS[s.status]}`} />
                <span className="st-role">{s.role}</span>
                <span className="st-goal">{s.goal}</span>
                <span className="st-meta">{duration(s)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="st-empty">This run hasn’t spawned any sub-agents.</div>
      )}
    </div>
  );
}
