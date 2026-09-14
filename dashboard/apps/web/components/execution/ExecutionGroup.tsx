"use client";

import { useState } from "react";
import { ExecutionStep } from "./ExecutionStep";
import type { ActivityGroup } from "@/lib/execution";

/**
 * One logical section of the trace (Research, Data acquisition, Analysis,
 * Delegation, Synthesis). Long runs collapse their settled sections to keep
 * the panel calm; the active section stays open, and any section can be
 * reopened. The header shows only what an operator needs to scan it: label,
 * how many steps, and a roll-up state.
 */
export function ExecutionGroup({
  group,
  isActive,
  currentId,
}: {
  group: ActivityGroup;
  isActive: boolean;
  /** the one running step that carries the accent — shared across all groups */
  currentId: string | null;
}) {
  const running = group.steps.some((s) => s.status === "running");
  const failed = group.steps.some((s) => s.status === "error");
  // Settled, non-active sections default to collapsed; the active one is open.
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? (isActive || running);

  const state = failed ? "error" : running ? "running" : "done";

  return (
    <section className="ax-group" data-state={state} data-open={open || undefined}>
      <button
        type="button"
        className="ax-group-head"
        aria-expanded={open}
        onClick={() => setUserOpen((v) => !(v ?? (isActive || running)))}
      >
        <span className="ax-group-caret" aria-hidden />
        <span className="ax-group-label">{group.label}</span>
        <span className="ax-group-count">
          {group.steps.length} step{group.steps.length === 1 ? "" : "s"}
        </span>
      </button>
      <ul className={`ax-steps ${open ? "" : "is-collapsed"}`} role="list">
        {group.steps.map((s) => (
          <ExecutionStep key={s.id} step={s} isCurrent={s.id === currentId} />
        ))}
      </ul>
    </section>
  );
}
