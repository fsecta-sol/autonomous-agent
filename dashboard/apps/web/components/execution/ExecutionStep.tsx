"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import { StatusIndicator } from "./StatusIndicator";
import { SubAgentCard } from "./SubAgentCard";
import { formatDuration, type ActivityKind, type ActivityStep } from "@/lib/execution";
import {
  IconBolt,
  IconBranch,
  IconCode,
  IconDoc,
  IconGlobe,
  IconOutput,
  IconPlan,
  IconShield,
  IconTable,
  IconThink,
} from "@/components/ui/icons";

const KIND_ICON: Record<ActivityKind, ReactNode> = {
  thinking: <IconThink />,
  "search-web": <IconGlobe />,
  "search-vault": <IconDoc />,
  "search-data": <IconTable />,
  read: <IconDoc />,
  plan: <IconPlan />,
  inspect: <IconTable />,
  "run-code": <IconCode />,
  delegate: <IconBranch />,
  validate: <IconShield />,
  output: <IconOutput />,
  answer: <IconOutput />,
  permission: <IconShield />,
  tool: <IconBolt />,
};

const PREVIEW_CHARS = 240;

/** A compact mono identity chip for an agent (initials), never an avatar. */
export function AgentLabel({ agent }: { agent: string }) {
  const initials = agent
    .split(/[\s_-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");
  return (
    <span className="ax-agent" title={agent}>
      {initials || "A"}
    </span>
  );
}

/** One activity on the execution spine. */
export function ExecutionStep({ step, isCurrent }: { step: ActivityStep; isCurrent: boolean }) {
  const duration = formatDuration(step.startedAt, step.finishedAt);
  const hasResult = typeof step.result === "string" && step.result.trim().length > 0;
  const [expanded, setExpanded] = useState(false);
  const branchCount = step.branches?.length ?? 0;

  // A delegation step is the orchestrator fanning work out to sub-agents. It
  // gets its own visual treatment (a fan-out of first-class sub-agent cards)
  // rather than the linear tool row, so "who did A1 spawn?" is answered at a
  // glance. Parallel spawns sit side by side; a single spawn reads as one card.
  const delegating = step.kind === "delegate";

  return (
    <li className="ax-step" data-state={step.status} data-current={isCurrent || undefined} data-kind={step.kind}>
      <span className="ax-rail" aria-hidden />
      <StatusIndicator status={step.status} />
      <div className="ax-body">
        <div className="ax-head">
          <span className="ax-kind">{KIND_ICON[step.kind]}</span>
          {step.agent ? <AgentLabel agent={step.agent} /> : null}
          <span className="ax-title">{step.title}</span>
          {duration ? <span className="ax-dur">{duration}</span> : null}
        </div>

        {step.description ? (
          <p className="ax-desc" title={step.description}>
            {step.description}
          </p>
        ) : null}

        {step.tool && !delegating ? (
          <div className="ax-tool">
            <span className="ax-tool-name">↳ {step.tool}</span>
          </div>
        ) : null}

        {step.permission ? <PermissionNote permission={step.permission} /> : null}

        {branchCount ? (
          <div className="sa-fanout">
            <div className="sa-grid" role="list">
              {step.branches!.map((b) => (
                <SubAgentCard key={b.id} branch={b} />
              ))}
            </div>
          </div>
        ) : delegating && step.status === "running" ? (
          <span className="sa-pending" role="status">
            awaiting sub-agent…
          </span>
        ) : null}

        {hasResult && !delegating ? (
          <div className="ax-result" data-expanded={expanded || undefined}>
            <div className="ax-result-head">
              <span className="ax-result-k">{step.status === "error" ? "Error" : "Result"}</span>
              {step.result!.length > PREVIEW_CHARS ? (
                <button type="button" className="ax-result-toggle" onClick={() => setExpanded((v) => !v)}>
                  {expanded ? "Show less" : "Show more"}
                </button>
              ) : null}
            </div>
            <pre className="ax-result-body">
              {expanded || step.result!.length <= PREVIEW_CHARS
                ? step.result
                : `${step.result!.slice(0, PREVIEW_CHARS).trimEnd()}…`}
            </pre>
          </div>
        ) : null}
      </div>
    </li>
  );
}

/**
 * The permission line on a protected tool's step — the audit record of WHY the
 * tool ran (or paused). Under bypass it reads "Permission bypassed": no approval
 * was requested, so it must never read "Approved". A request resolved by an
 * ASK→BYPASS switch reads "Auto-approved · BYPASS" — a mode change, explicitly
 * not an operator approval. Under ask it reads "Awaiting approval" while paused.
 */
function PermissionNote({ permission }: { permission: NonNullable<ActivityStep["permission"]> }) {
  const bypass = permission.mode === "bypass";
  const byMode = permission.reason === "mode-change";
  const label =
    permission.decision === "bypassed"
      ? byMode
        ? "Auto-approved · BYPASS"
        : "Permission bypassed"
      : permission.decision === "approved"
        ? "Approval granted"
        : permission.decision === "rejected" || permission.decision === "denied"
          ? "Approval rejected"
          : "Awaiting approval";
  return (
    <div className="ax-perm" data-decision={permission.decision}>
      <span className="ax-perm-mark" aria-hidden />
      <span className="ax-perm-label">{label}</span>
      <span className="ax-perm-policy">Policy: {bypass ? "BYPASS" : "ASK"}</span>
    </div>
  );
}
