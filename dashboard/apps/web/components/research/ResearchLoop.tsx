"use client";

import type { RunStatus, RunStage } from "@/lib/research-loop";
import { isTerminal, stageLabel } from "./shared";

/**
 * The Research Loop visualization. Its highlight is derived entirely from the
 * run's real `stage` (the engine's `research.models.STAGES` state machine), not
 * from a frontend timer — so it can never claim a phase is running that isn't.
 *
 * The five phases are a stable grouping of the engine's 14 stages; `phaseOf`
 * is the only mapping, and every stage resolves to exactly one phase.
 */
const PHASES = ["Research", "Collect Evidence", "Analyze", "Update Knowledge", "Evaluate"] as const;

/** Which phase a stage belongs to, or -1 for a non-phase state (WAITING). */
function phaseOf(stage: RunStage): number {
  switch (stage) {
    case "IDLE":
    case "LOADING_CONTEXT":
    case "ANALYZING_KNOWLEDGE":
    case "GENERATING_CANDIDATES":
    case "PRIORITIZING":
    case "PLANNING":
      return 0;
    case "EXECUTING":
    case "COLLECTING_EVIDENCE":
      return 1;
    case "ANALYZING_RESULT":
      return 2;
    case "UPDATING_KNOWLEDGE":
      return 3;
    case "EVALUATING_PROGRESS":
    case "DECIDING_NEXT_ACTION":
      return 4;
    default:
      // WAITING / DONE have no phase of their own
      return -1;
  }
}

export function ResearchLoop({
  status,
  stage,
  iteration,
}: {
  status: RunStatus;
  stage: RunStage;
  iteration: number;
}) {
  const terminal = isTerminal(status);
  const paused = status === "PAUSED" || status === "WAITING" || status === "BLOCKED";
  const complete = terminal && status === "COMPLETED";
  const current = phaseOf(stage);

  const loopState = complete ? "finished" : terminal ? "stopped" : paused ? "waiting" : "running";

  return (
    <div className="rl-loop" data-state={loopState}>
      <div className="rl-loop-head">
        <span className="rl-loop-title">Research Loop</span>
        <span className="rl-loop-meta">
          <span className="rl-loop-state" data-state={loopState}>
            {complete ? "Finished" : terminal ? "Stopped" : paused ? "Waiting" : "Running"}
          </span>
          <span className="rl-loop-iter">Iteration {iteration}</span>
        </span>
      </div>

      <ol className="rl-loop-phases">
        {PHASES.map((label, i) => {
          const state = complete
            ? "done"
            : current < 0
              ? i === 0
                ? "queued"
                : "queued"
              : i < current
                ? "done"
                : i === current
                  ? paused
                    ? "paused"
                    : "current"
                  : "queued";
          const sub = i === current && !complete ? stageLabel(stage) : phaseSub(label);
          return (
            <li key={label} className="rl-phase" data-state={state}>
              <span className="rl-phase-marker" aria-hidden>
                {state === "done" ? "✓" : state === "current" || state === "paused" ? "●" : "○"}
              </span>
              <span className="rl-phase-body">
                <span className="rl-phase-label">{label}</span>
                <span className="rl-phase-sub">{sub}</span>
              </span>
            </li>
          );
        })}
      </ol>

      <div className="rl-loop-tail" data-state={loopState}>
        <span className="rl-loop-back" aria-hidden>
          ↺
        </span>
        <span>next iteration — or stop when the objective is satisfied</span>
      </div>
    </div>
  );
}

/** The default sub-line for a phase when it is not the live one. */
function phaseSub(label: string): string {
  switch (label) {
    case "Research":
      return "find the next gap worth closing";
    case "Collect Evidence":
      return "gather observations and sources";
    case "Analyze":
      return "evidence → findings, keep interpretation separate";
    case "Update Knowledge":
      return "integrate into the knowledge graph";
    case "Evaluate":
      return "information gain → continue, branch, or stop";
    default:
      return "";
  }
}
