"use client";

import { useEffect, useRef } from "react";
import { IconBolt, IconCheck, IconRefresh, IconShield } from "@/components/ui/icons";
import type { InterruptEvent } from "@/lib/llm-stream";

/** Where a pending tool-approval is in its decision lifecycle. */
export type ApprovalPhase = "waiting" | "submitting" | "approved" | "rejected" | "error";

/** A live approval checkpoint: the interrupt the run is paused on, plus the
 *  operator's decision progress. One object is the whole truth — the run is
 *  paused iff this is non-null and `phase` is not yet resolved. */
export interface ApprovalState {
  interrupt: InterruptEvent;
  phase: ApprovalPhase;
  /** the decision being submitted / already taken. `bypass` is the ASK→BYPASS
   *  auto-resolve: the request is cleared by the mode switch, not by the operator. */
  decision?: "approve" | "deny" | "bypass";
  /** a failure to surface when `phase === "error"` */
  error?: string;
}

const PHASE_BADGE: Record<ApprovalPhase, string> = {
  waiting: "Waiting for approval",
  submitting: "Submitting…",
  approved: "Approved",
  rejected: "Rejected",
  error: "Action needed",
};

/**
 * A first-class execution checkpoint, not a toast. It renders inside the
 * conversation the moment a real interrupt envelope arrives, states exactly
 * which tool the agent wants to run and on what, and carries the decision
 * through WAITING → SUBMITTING → APPROVED / REJECTED (or ERROR with retry).
 *
 * A malformed interrupt (no tool, no args) never silently disappears: it
 * renders a visible fallback with the raw payload behind a disclosure so an
 * operator/dev can see what actually arrived.
 */
export function ApprovalCard({
  state,
  agentName,
  onDecide,
}: {
  state: ApprovalState;
  agentName?: string;
  onDecide: (decision: "approve" | "deny") => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Pull focus on first mount so a keyboard/SR operator lands on the decision,
  // not mid-scroll. Re-focusing on every phase change would fight the buttons.
  useEffect(() => {
    ref.current?.focus();
  }, []);

  const { interrupt, phase } = state;
  const tool = interrupt.tool;
  const args = interrupt.args ?? {};
  const command = typeof args.command === "string" ? args.command : null;
  const mode = typeof args.mode === "string" ? args.mode : null;
  const details = Object.entries(args).filter(([k]) => k !== "command" && k !== "mode");
  const renderable = Boolean(tool || command || details.length);

  const waiting = phase === "waiting";
  const submitting = phase === "submitting";
  // A full-access command is the one case worth a visually raised risk line.
  const danger = mode === "unsandboxed";
  // The request is being resolved by an ASK→BYPASS switch, not by the operator:
  // the pending tool is about to run without the gate. Distinct, honest wording.
  const autoResolving = submitting && state.decision === "bypass";

  const badgeLabel = autoResolving
    ? "BYPASS active"
    : submitting && state.decision === "deny"
      ? "Rejecting…"
      : PHASE_BADGE[phase];

  return (
    <div
      className="apx"
      data-phase={phase}
      data-tone={danger ? "danger" : "normal"}
      role="group"
      aria-label="Tool approval required"
      ref={ref}
      tabIndex={-1}
      data-od-id="approval-prompt"
    >
      <div className="apx-head">
        <span className="apx-icon" aria-hidden>
          <IconBolt />
        </span>
        <span className="apx-title">Approval required</span>
        <span className="apx-badge" data-phase={phase}>
          {submitting ? <span className="apx-spin" aria-hidden /> : null}
          {badgeLabel}
        </span>
      </div>

      {renderable ? (
        <>
          <div className="apx-op">
            <span className="apx-tool" title={tool ?? undefined}>
              {tool ?? "unknown tool"}
            </span>
            {agentName ? <span className="apx-agent">requested by {agentName}</span> : null}
          </div>

          {command ? (
            <pre className="apx-cmd" aria-label="Command to run">
              <span className="apx-prompt" aria-hidden>
                $
              </span>
              {command}
            </pre>
          ) : null}

          <div className="apx-meta">
            <span className="apx-chip apx-chip-policy" data-mode="ask">
              <IconShield aria-hidden />
              Policy: ASK
            </span>
            {mode ? (
              <span className="apx-chip" data-risk={danger ? "high" : "low"}>
                {mode === "unsandboxed" ? "unsandboxed · full access" : "sandbox"}
              </span>
            ) : null}
            {details.map(([k, v]) => (
              <span className="apx-chip" key={k}>
                <span className="apx-chip-k">{k}</span>
                {typeof v === "string" ? v : JSON.stringify(v)}
              </span>
            ))}
          </div>
        </>
      ) : (
        <p className="apx-fallback">
          Approval request received, but this UI could not render the approval details.
        </p>
      )}

      {/* The pending request is being cleared by an ASK→BYPASS switch. State the
          outcome plainly and transition into execution — this is not the
          operator's approval, and the wording never implies it is. */}
      {autoResolving ? (
        <p className="apx-note apx-note-mode">
          <b>BYPASS active</b> · 1 pending approval automatically approved — running now.
        </p>
      ) : null}

      {phase === "approved" ? <p className="apx-note">Approved — the command is running now.</p> : null}
      {phase === "rejected" ? (
        <p className="apx-note">Rejected — the run continued without running this command.</p>
      ) : null}
      {phase === "error" ? <p className="apx-note apx-note-err">{state.error ?? "Could not complete the approval."}</p> : null}

      {/* the operator decides when still waiting, or retries after a failure;
          a submitting/resolved card shows state only */}
      {waiting || phase === "error" ? (
        <div className="apx-actions">
          <button type="button" className="apx-reject" disabled={submitting} onClick={() => onDecide("deny")}>
            {phase === "error" ? "Retry reject" : "Reject"}
          </button>
          <button type="button" className="apx-approve" disabled={submitting} onClick={() => onDecide("approve")}>
            {phase === "error" ? <IconRefresh aria-hidden /> : <IconCheck aria-hidden />}
            {phase === "error" ? "Retry approve" : "Approve & run"}
          </button>
        </div>
      ) : null}

      {!renderable ? (
        <details className="apx-details">
          <summary>Details</summary>
          <pre className="apx-details-body">{JSON.stringify(interrupt, null, 2)}</pre>
        </details>
      ) : null}
    </div>
  );
}
