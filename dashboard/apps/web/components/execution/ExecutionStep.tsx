"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import { StatusIndicator } from "./StatusIndicator";
import { formatDuration, type ActivityBranch, type ActivityKind, type ActivityStep } from "@/lib/execution";
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

  return (
    <li className="ax-step" data-state={step.status} data-current={isCurrent || undefined}>
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

        {step.tool ? (
          <div className="ax-tool">
            <span className="ax-tool-name">↳ {step.tool}</span>
            {branchCount ? <span className="ax-tool-count">{branchCount} sub-agent{branchCount === 1 ? "" : "s"}</span> : null}
          </div>
        ) : null}

        {branchCount ? (
          <ul className="ax-branches" role="list">
            {step.branches!.map((b) => (
              <BranchRow key={b.id} branch={b} />
            ))}
          </ul>
        ) : null}

        {hasResult ? (
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

/** One live sub-agent under a delegation step. */
function BranchRow({ branch }: { branch: ActivityBranch }) {
  const duration = formatDuration(branch.startedAt ?? 0, branch.finishedAt);
  return (
    <li className="ax-branch" data-state={branch.status}>
      <span className="ax-branch-node" aria-hidden />
      <AgentLabel agent={branch.agent} />
      <span className="ax-branch-label" title={branch.label || branch.agent}>
        {branch.label || branch.agent}
      </span>
      <span className="ax-branch-status">
        {branch.status === "running" ? "running" : branch.status === "error" ? "failed" : duration ?? "done"}
      </span>
    </li>
  );
}
