"use client";

import { useMemo } from "react";
import { ExecutionGroup } from "./ExecutionGroup";
import { buildGroups, type ActivityStep } from "@/lib/execution";

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
  const groups = useMemo(() => buildGroups(steps), [steps]);
  // Exactly one node carries Instrument-Blue: the freshest still-running step.
  // Even when a run has several parallel activities, there is one active voice.
  const currentId = useMemo(() => {
    for (let i = steps.length - 1; i >= 0; i--) if (steps[i].status === "running") return steps[i].id;
    return null;
  }, [steps]);
  if (!steps.length) return null;

  const done = steps.filter((s) => s.status === "done").length;
  const summary =
    state === "running"
      ? `Working — ${done}/${steps.length} complete`
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
        </span>
      </div>
      <div className="ax-groups">
        {groups.map((g, i) => (
          <ExecutionGroup key={g.id} group={g} isActive={state === "running" && i === groups.length - 1} currentId={currentId} />
        ))}
      </div>
    </section>
  );
}
