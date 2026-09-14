"use client";

import type { SpawnEvent } from "@/lib/api";

const BLK_CLASS: Record<SpawnEvent["status"], string> = {
  running: "run",
  done: "done",
  timed_out: "warn",
  error: "bad",
};

/**
 * When each sub-agent ran, on one shared axis. Block widths are real durations
 * from the spawn log; spawns with no timing (read from an old checkpoint) are
 * listed but not placed.
 */
export function RunTimeline({ spawns, selectedId, onSelect }: {
  spawns: SpawnEvent[];
  selectedId: string | null;
  onSelect: (s: SpawnEvent) => void;
}) {
  const timed = spawns.filter((s) => s.startedAt !== undefined);
  if (!timed.length) {
    return <div className="rt-empty">No timing recorded for this run’s spawns.</div>;
  }

  const now = Date.now();
  const start = Math.min(...timed.map((s) => s.startedAt!));
  const end = Math.max(...timed.map((s) => s.finishedAt ?? (s.status === "running" ? now : s.startedAt!)));
  const span = Math.max(1, end - start);

  return (
    <div className="run-timeline" data-od-id="run-timeline">
      {timed.map((s) => {
        const left = ((s.startedAt! - start) / span) * 100;
        const width = Math.max(2, (((s.finishedAt ?? (s.status === "running" ? now : s.startedAt!)) - s.startedAt!) / span) * 100);
        return (
          <div className="rt-lane" key={s.id ?? `${s.role}-${s.startedAt}`}>
            <span className="rt-name" title={s.role}>{s.role}</span>
            <button
              type="button"
              className={`rt-track ${selectedId === s.id ? "is-sel" : ""}`}
              aria-label={`${s.role}: ${s.status}`}
              onClick={() => onSelect(s)}
            >
              <span className={`rt-blk ${BLK_CLASS[s.status]}`} style={{ left: `${left}%`, width: `${width}%` }} />
            </button>
          </div>
        );
      })}
      <div className="rt-axis">
        <span>start</span>
        <span>{Math.round(span / 1000)}s</span>
      </div>
    </div>
  );
}
