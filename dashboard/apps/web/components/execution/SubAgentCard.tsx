"use client";

import { useState } from "react";
import { formatDuration, type ActivityBranch } from "@/lib/execution";

const PREVIEW_CHARS = 220;

function clip(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
}

/**
 * One sub-agent the orchestrator spawned, as a first-class card rather than a
 * log line. It shows the four facts an operator needs without opening anything:
 * which worker (role), what it was handed (the goal), where it is (status +
 * duration), and what it returned (result summary, once settled). The status
 * mark is a small shape in the card header — the design system's one reserved
 * information shape — never a colored rule.
 */
export function SubAgentCard({ branch }: { branch: ActivityBranch }) {
  const duration = formatDuration(branch.startedAt ?? 0, branch.finishedAt);
  const hasResult = typeof branch.result === "string" && branch.result.trim().length > 0;
  const [expanded, setExpanded] = useState(false);
  const long = hasResult && branch.result!.length > PREVIEW_CHARS;

  const statusWord =
    branch.status === "running" ? "running" : branch.status === "error" ? "failed" : "completed";

  return (
    <article className="sa-card" data-state={branch.status} aria-label={`Sub-agent ${branch.agent}`}>
      <header className="sa-head">
        <span className="sa-mark" aria-hidden />
        <span className="sa-role" title={branch.agent}>
          {branch.agent}
        </span>
        <span className="sa-dur">{branch.status === "running" ? "running" : duration ?? statusWord}</span>
      </header>

      <p className="sa-task" title={branch.label}>
        {branch.label}
      </p>

      {hasResult ? (
        <div className="sa-result" data-error={branch.status === "error" || undefined}>
          <span className="sa-result-k">{branch.status === "error" ? "Error" : "Result"}</span>
          <p className="sa-result-body">
            {expanded || !long ? branch.result : clip(branch.result!, PREVIEW_CHARS)}
          </p>
          {long ? (
            <button type="button" className="sa-result-toggle" onClick={() => setExpanded((v) => !v)}>
              {expanded ? "Show less" : "Show more"}
            </button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
