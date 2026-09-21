"use client";

import { useState } from "react";
import { IconActivity, IconChevronDown } from "@/components/ui/icons";
import type { ActivityStep } from "@/lib/execution";

/** Count the tool operations in a settled trace (thinking/answer are not tools). */
function toolCounts(steps: ActivityStep[]): { ran: number; failed: number } {
  let ran = 0;
  let failed = 0;
  for (const s of steps) {
    if (s.kind === "thinking" || s.kind === "answer") continue;
    ran += 1;
    if (s.status === "error") failed += 1;
  }
  return { ran, failed };
}

/**
 * The line under a settled reply that states what the execution actually did —
 * so a natural-language answer can never imply an action that never happened.
 *
 * It answers one question honestly, from the real trace:
 *   - tools ran            → "N tool operations executed" (with a failure count)
 *   - nothing ran, capable  → "No tools were invoked" (amber), expandable to say
 *                             the agent can run tools but used none this reply
 *   - nothing ran, incapable→ renders nothing (the agent has no tools to call)
 *
 * This is the fix for the silent no-op: an operator who asked for a write and
 * got prose instead sees "No tools were invoked", not a normal-looking success.
 */
export function ExecutionOutcome({
  steps,
  capable,
}: {
  steps: ActivityStep[];
  /** true when the agent has at least one tool it could call */
  capable: boolean;
}) {
  const { ran, failed } = toolCounts(steps);
  const [open, setOpen] = useState(false);

  if (ran === 0 && !capable) return null;

  if (ran === 0) {
    return (
      <div className="eout" data-tone="warn" data-od-id="execution-outcome">
        <button
          type="button"
          className="eout-row"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="eout-mark" aria-hidden />
          <span className="eout-text">
            No tools were invoked.
            <span className="eout-sub">This reply used reasoning only — no command or tool call ran.</span>
          </span>
          <span className="eout-caret" aria-hidden>
            <IconChevronDown />
          </span>
        </button>
        {open ? (
          <dl className="eout-details">
            <div>
              <dt>Tools available</dt>
              <dd>yes</dd>
            </div>
            <div>
              <dt>Tools invoked</dt>
              <dd>none</dd>
            </div>
            <div>
              <dt>Changes made</dt>
              <dd>none</dd>
            </div>
          </dl>
        ) : null}
      </div>
    );
  }

  const tone = failed > 0 ? "err" : "ok";
  return (
    <div className="eout" data-tone={tone} data-od-id="execution-outcome">
      <div className="eout-row eout-row-static">
        <span className="eout-mark" aria-hidden />
        <span className="eout-text">
          <IconActivity aria-hidden />
          {ran} tool operation{ran === 1 ? "" : "s"} executed
          {failed > 0 ? ` · ${failed} failed` : ""}.
        </span>
      </div>
    </div>
  );
}
