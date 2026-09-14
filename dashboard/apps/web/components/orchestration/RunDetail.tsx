"use client";

import type { SpawnEvent } from "@/lib/api";
import { IconClose } from "@/components/ui/icons";

const STATUS_LABEL: Record<SpawnEvent["status"], string> = {
  running: "Running",
  done: "Done",
  timed_out: "Timed out",
  error: "Failed",
};

function fmtTime(ms?: number | null): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function fmtDuration(s: SpawnEvent): string {
  if (s.startedAt === undefined) return "—";
  const end = s.finishedAt ?? (s.status === "running" ? Date.now() : s.startedAt);
  const secs = Math.max(0, Math.round((end - s.startedAt) / 1000));
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

/** Detail for one sub-agent spawn: its goal, timing, and returned result. */
export function RunDetail({ spawn, onClose }: { spawn: SpawnEvent; onClose: () => void }) {
  return (
    <>
      <div className="orch-dhead">
        <div style={{ flex: 1, minWidth: 0 }}>
          <strong style={{ fontSize: 14 }}>{spawn.role}</strong>
          <div className={`orch-pill sp-${spawn.status}`} style={{ marginTop: 4 }}>
            <i className="dot" />
            {STATUS_LABEL[spawn.status]}
          </div>
        </div>
        <button className="icon-btn" aria-label="Close panel" onClick={onClose}>
          <IconClose />
        </button>
      </div>
      <div className="orch-dbody">
        <div>
          <div className="orch-sec-k">Timing</div>
          <div className="sp-timing">
            <span>{fmtTime(spawn.startedAt)} → {fmtTime(spawn.finishedAt)}</span>
            <span className="sp-dur">{fmtDuration(spawn)}</span>
          </div>
        </div>
        <div>
          <div className="orch-sec-k">Goal</div>
          <p className="sp-goal">{spawn.goal || "—"}</p>
        </div>
        <div>
          <div className="orch-sec-k">Result</div>
          <pre className="sp-result">{spawn.result || (spawn.status === "running" ? "Still running…" : "—")}</pre>
        </div>
      </div>
    </>
  );
}
