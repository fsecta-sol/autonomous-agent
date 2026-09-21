"use client";

import { useRef } from "react";
import { StatusLamp, stateLabel } from "@/components/execution/AgentTelemetryStrip";
import { useDismissible } from "@/components/ui/useDropdown";
import {
  IconChevronDown,
  IconChevronLeft,
  IconChip,
  IconPlus,
  IconSearch,
  IconShield,
  IconSwarm,
} from "@/components/ui/icons";
import type { Agent, PermissionMode, TelemetryState } from "@dashboard/shared";

/**
 * The console header: which autonomous worker you are addressing, whether it is
 * alive, on which model, and the actions scoped to it. It replaces the old
 * generic chat topbar — the operator selects an active agent here, not "a chat".
 */
export function AgentHeader({
  agent,
  title,
  status,
  statusDetail,
  heartbeatText,
  onBack,
  model,
  modelOptions,
  modelDefault,
  onChooseModel,
  permissionMode,
  permissionDefault,
  onChoosePermission,
  sending,
  onNewChat,
  onFocusGraph,
  sessionId,
  railOpen,
  onToggleRail,
}: {
  agent: Agent;
  /** the active session's title */
  title: string;
  status: TelemetryState;
  statusDetail: string | null;
  /** the heartbeat reading, e.g. "2.1s ago" — null when never seen */
  heartbeatText: string | null;
  onBack: () => void;
  model: string;
  modelOptions: string[];
  modelDefault: string;
  onChooseModel: (m: string) => void;
  /** the session's effective tool-execution policy (ask/bypass) */
  permissionMode: PermissionMode;
  /** the agent's default policy, shown so an override is legible */
  permissionDefault: PermissionMode;
  onChoosePermission: (m: PermissionMode) => void;
  sending: boolean;
  onNewChat: () => void;
  onFocusGraph: () => void;
  sessionId: string | null;
  /** the rail is showing as a drawer (below the tablet breakpoint) */
  railOpen: boolean;
  onToggleRail: () => void;
}) {
  const modelRef = useRef<HTMLDivElement | null>(null);
  const modelMenu = useDismissible(modelRef);
  const permRef = useRef<HTMLDivElement | null>(null);
  const permMenu = useDismissible(permRef);

  return (
    <header className="console-head" data-od-id="agent-head">
      <button type="button" className="rd-back" data-od-id="swarm-back" onClick={onBack}>
        <IconChevronLeft />
        All agents
      </button>

      <span className="ch-avatar" aria-hidden>
        {agent.name.charAt(0).toUpperCase()}
      </span>

      <span className="ch-id">
        <span className="ch-name">{agent.name}</span>
        <span className="ch-role">{agent.role || "Agent"}</span>
      </span>

      <span className="ch-live" data-state={status}>
        <StatusLamp state={status} />
        <span className="ch-live-text">
          <span className="ch-live-word">
            {stateLabel(status)}
            {heartbeatText ? <span className="ch-live-beat"> · heartbeat {heartbeatText}</span> : null}
          </span>
          {statusDetail ? <span className="ch-live-sub">{statusDetail}</span> : null}
        </span>
      </span>

      <span className="ch-session" title={sessionId ? `${title} · ${sessionId}` : title}>
        <span className="ch-session-k">Session</span>
        <span className="ch-session-v">{title}</span>
        {sessionId ? <span className="ch-session-id">{sessionId.slice(0, 8)}</span> : null}
      </span>

      <div className="ch-actions">
        <button
          type="button"
          className="ch-focus"
          data-od-id="agent-focus-graph"
          disabled={!agent.currentNode}
          title={agent.currentNode ? `Focus "${agent.currentNode}" in the graph` : "No linked node"}
          onClick={onFocusGraph}
        >
          <IconSearch />
          <span>Focus in graph</span>
        </button>

        <div className="perm-pick" ref={permRef} data-od-id="permission-pick" data-mode={permissionMode}>
          <button
            type="button"
            className="perm-btn"
            aria-haspopup="menu"
            aria-expanded={permMenu.open}
            title="Tool-execution policy for this session"
            onClick={permMenu.toggle}
          >
            <IconShield />
            <span className="perm-btn-k">Permission</span>
            <span className="perm-btn-label">{permissionMode === "bypass" ? "Bypass" : "Ask"}</span>
            <IconChevronDown />
          </button>
          {permMenu.open ? (
            <div className="perm-menu" role="menu" aria-label="Tool-execution policy for this session">
              <div className="perm-menu-head">Permission · this session</div>
              <button
                type="button"
                className={`perm-opt${permissionMode === "ask" ? " is-active" : ""}`}
                role="menuitemradio"
                aria-checked={permissionMode === "ask"}
                onClick={() => onChoosePermission("ask")}
              >
                <span className="perm-dot" data-mode="ask" aria-hidden />
                <span className="perm-opt-body">
                  <span className="perm-opt-name">Ask</span>
                  <span className="perm-opt-sub">Require approval before protected tool actions.</span>
                </span>
                {permissionDefault === "ask" ? <span className="perm-opt-tag">default</span> : null}
              </button>
              <button
                type="button"
                className={`perm-opt${permissionMode === "bypass" ? " is-active" : ""}`}
                role="menuitemradio"
                aria-checked={permissionMode === "bypass"}
                onClick={() => onChoosePermission("bypass")}
              >
                <span className="perm-dot" data-mode="bypass" aria-hidden />
                <span className="perm-opt-body">
                  <span className="perm-opt-name">Bypass</span>
                  <span className="perm-opt-sub">Run protected actions without the approval gate.</span>
                </span>
                {permissionDefault === "bypass" ? <span className="perm-opt-tag">default</span> : null}
              </button>
              {permissionDefault !== permissionMode ? (
                <button
                  type="button"
                  className="perm-reset"
                  onClick={() => onChoosePermission(permissionDefault)}
                >
                  Reset to agent default ({permissionDefault === "bypass" ? "Bypass" : "Ask"})
                </button>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="model-pick" ref={modelRef} data-od-id="model-pick">
          <button
            type="button"
            className="model-btn"
            aria-haspopup="menu"
            aria-expanded={modelMenu.open}
            disabled={sending}
            title="Model for this conversation"
            onClick={modelMenu.toggle}
          >
            <IconChip />
            <span className="model-btn-label">{model || "Auto"}</span>
            <IconChevronDown />
          </button>
          {modelMenu.open ? (
            <div className="model-menu" role="menu" aria-label="Model for this conversation">
              <div className="model-menu-head">Model · this conversation</div>
              <button
                type="button"
                className={`model-opt${model === "" ? " is-active" : ""}`}
                role="menuitemradio"
                aria-checked={model === ""}
                onClick={() => onChooseModel("")}
              >
                <span className="model-opt-name">Auto</span>
                <span className="model-opt-sub">{modelDefault || "server default"}</span>
              </button>
              {modelOptions.map((m) => (
                <button
                  key={m}
                  type="button"
                  className={`model-opt${model === m ? " is-active" : ""}`}
                  role="menuitemradio"
                  aria-checked={model === m}
                  onClick={() => onChooseModel(m)}
                >
                  <span className="model-opt-name">{m}</span>
                  {m === modelDefault ? <span className="model-opt-sub">default</span> : null}
                </button>
              ))}
              {modelOptions.length === 0 ? (
                <div className="model-menu-empty">No models listed — the server auto-detects.</div>
              ) : null}
            </div>
          ) : null}
        </div>

        <button className="newchat-btn" data-od-id="new-chat" onClick={onNewChat}>
          <IconPlus />
          <span>New chat</span>
        </button>

        <button
          type="button"
          className="ch-rail-toggle"
          aria-pressed={railOpen}
          aria-label={railOpen ? "Hide console panel" : "Show console panel"}
          title={railOpen ? "Hide console panel" : "Show console panel"}
          onClick={onToggleRail}
        >
          <IconSwarm />
        </button>
      </div>
    </header>
  );
}
