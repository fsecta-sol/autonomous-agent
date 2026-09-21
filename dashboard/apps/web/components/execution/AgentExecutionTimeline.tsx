"use client";

import { useEffect, useMemo, useState } from "react";
import { ExecutionGroup } from "./ExecutionGroup";
import { formatDuration, buildGroups, coalesceDelegations, type ActivityStep } from "@/lib/execution";

export type TraceState = "running" | "done" | "error";

/**
 * The live execution trace for one turn: a vertical spine of activity groups
 * that stream in as the agent works. It is driven entirely by the step list
 * folded from the stream — nothing here is hardcoded, and it renders nothing
 * until there is at least one step, so the pre-turn bubble stays untouched.
 *
 * The trace communicates *what the agent did*; the answer bubble that follows
 * communicates *what it concluded*. They do not compete: the trace is quiet,
 * mono, and settled once the turn ends.
 */
export function AgentExecutionTimeline({
  steps,
  state,
  agentName,
}: {
  steps: ActivityStep[];
  state: TraceState;
  agentName?: string;
}) {
  // Adjacent delegate steps are one delegation event on screen — an orchestrator
  // that fires several spawn_subagent calls back to back shows a single fan-out,
  // not a column of near-empty rows. Coalesce before grouping/counting so the
  // progress denominator matches what the operator sees.
  const shown = useMemo(() => coalesceDelegations(steps), [steps]);
  const groups = useMemo(() => buildGroups(shown), [shown]);
  // Exactly one node carries Instrument-Blue: the freshest still-running step.
  // Even when a run has several parallel activities, there is one active voice.
  const currentId = useMemo(() => {
    for (let i = shown.length - 1; i >= 0; i--) if (shown[i].status === "running") return shown[i].id;
    return null;
  }, [shown]);

  // Live wall-clock while the run is streaming, so the header carries a running
  // elapsed time; it stops ticking the moment the run settles.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (state !== "running") return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [state]);

  if (!steps.length) return null;

  const done = shown.filter((s) => s.status === "done").length;
  const total = shown.length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const elapsed = state === "running" ? formatDuration(shown[0].startedAt, now) : null;
  const summary =
    state === "running"
      ? `Working — ${done}/${total} complete`
      : state === "error"
        ? "Run stopped"
        : "Execution complete";

  return (
    <section className="ax-timeline" data-od-id="execution-timeline" data-state={state} aria-label="Agent execution trace">
      <div className="ax-timeline-head">
        <span className="ax-tl-label">{agentName ? `${agentName} — execution` : "Execution"}</span>
        <span className={`ax-tl-summary is-${state}`}>
          {state === "running" ? <span className="ax-live" aria-hidden /> : null}
          {summary}
          {elapsed ? <span className="ax-tl-elapsed">{elapsed}</span> : null}
        </span>
      </div>
      {state === "running" ? (
        <div className="ax-progress" role="progressbar" aria-valuenow={done} aria-valuemin={0} aria-valuemax={total}>
          <span className="ax-progress-fill" style={{ width: `${pct}%` }} />
        </div>
      ) : null}
      <div className="ax-groups">
        {groups.map((g, i) => (
          <ExecutionGroup key={g.id} group={g} isActive={state === "running" && i === groups.length - 1} currentId={currentId} />
        ))}
      </div>
    </section>
  );
}
