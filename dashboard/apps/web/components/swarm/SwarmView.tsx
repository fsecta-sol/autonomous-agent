"use client";

import { useMemo, useState } from "react";
import { useWorkspace } from "@/components/providers/workspace";
import { SwarmActivityStream } from "./SwarmActivityStream";
import { AgentDetail } from "./AgentDetail";
import { AgentForm } from "./AgentForm";
import { deleteAgentRecord } from "@/lib/api";
import { Modal } from "@/components/ui/Modal";
import { IconEdit, IconPlus, IconTrash } from "@/components/ui/icons";
import type { Agent } from "@dashboard/shared";

type Filter = "all" | "working" | "attention" | "idle";

const STATUS_LABEL: Record<string, string> = {
  working: "Working",
  analysing: "Analysing",
  idle: "Idle",
  pending: "Pending",
};

function needsAttention(a: Agent): boolean {
  return a.status === "pending" || !a.health.beatOk || a.health.errWarn || a.health.incidents.length > 0;
}

export function SwarmView() {
  const { agents, selectedAgentId, openAgent, closeAgent, removeAgent, refreshAgents } = useWorkspace();
  const [filter, setFilter] = useState<Filter>("all");
  const [formAgentId, setFormAgentId] = useState<string | null | undefined>(undefined); // undefined=closed, null=new
  const [deleting, setDeleting] = useState<Agent | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const active = selectedAgentId ? agents.find((a) => a.id === selectedAgentId) ?? null : null;

  const summary = useMemo(() => {
    const working = agents.filter((a) => a.status === "working" || a.status === "analysing").length;
    const idle = agents.filter((a) => a.status === "idle").length;
    const attention = agents.filter(needsAttention).length;
    const tasks = agents.reduce((sum, a) => sum + (parseInt(a.count, 10) || 0), 0);
    return { working, idle, attention, tasks, total: agents.length };
  }, [agents]);

  const rows = useMemo(() => {
    return agents.filter((a) => {
      if (filter === "all") return true;
      if (filter === "working") return a.status === "working" || a.status === "analysing";
      if (filter === "attention") return needsAttention(a);
      if (filter === "idle") return a.status === "idle";
      return true;
    });
  }, [agents, filter]);

  const onSaved = async () => {
    setFormAgentId(undefined);
    await refreshAgents();
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setDeleteError(null);
    try {
      await deleteAgentRecord(deleting.id);
      removeAgent(deleting.id);
      setDeleting(null);
    } catch {
      setDeleteError("Could not delete the agent.");
    }
  };

  if (active) {
    return <AgentDetail key={active.id} agent={active} onBack={closeAgent} />;
  }

  const empty = agents.length === 0;

  return (
    <section className="view active" data-od-id="view-swarm">
      <div className="swarm-index">
        <div className="panel-header">
          <h2>Swarm command</h2>
          <button className="newchat-btn" data-od-id="swarm-new" onClick={() => setFormAgentId(null)}>
            <IconPlus />
            New agent
          </button>
        </div>

        {empty ? (
          <div className="swarm-empty" data-od-id="swarm-empty">
            <span className="se-orb" aria-hidden>
              <svg viewBox="0 0 64 64" fill="none" stroke="currentColor">
                <circle cx="32" cy="32" r="6" fill="currentColor" stroke="none" />
                <circle cx="32" cy="32" r="14" strokeWidth="1.5" opacity=".5" />
                <circle cx="32" cy="32" r="23" strokeWidth="1.1" strokeDasharray="3 4" opacity=".35" />
              </svg>
            </span>
            <h3>No agents yet</h3>
            <p>Build your first agent — give it a role, its own model or endpoint, tools, skills, MCP servers, and a terminal.</p>
            <button className="newchat-btn" type="button" onClick={() => setFormAgentId(null)}>
              <IconPlus />
              Create your first agent
            </button>
          </div>
        ) : (
          <>
            <div className="swarm-summary" aria-label="Swarm status summary">
              <div className="swarm-stat">
                <span className="swarm-stat-k">Agents online</span>
                <span className="swarm-stat-v">{summary.total}</span>
              </div>
              <div className="swarm-stat">
                <span className="swarm-stat-k">Active</span>
                <span className="swarm-stat-v">{summary.working}</span>
              </div>
              <div className="swarm-stat">
                <span className="swarm-stat-k">Idle</span>
                <span className="swarm-stat-v">{summary.idle}</span>
              </div>
              <div className={`swarm-stat ${summary.attention > 0 ? "is-attention" : ""}`}>
                <span className="swarm-stat-k">Needs attention</span>
                <span className="swarm-stat-v">{summary.attention}</span>
              </div>
            </div>

            <div className="swarm-toolbar">
              <div className="swarm-filters" role="group" aria-label="Filter agents by status">
                {(["all", "working", "attention", "idle"] as Filter[]).map((f) => (
                  <button type="button" className="swarm-filter" key={f} aria-pressed={filter === f} onClick={() => setFilter(f)}>
                    {f === "all" ? "All" : f === "working" ? "Active" : f === "attention" ? "Attention" : "Idle"}
                  </button>
                ))}
              </div>
              <span className="swarm-results">
                {rows.length} of {agents.length} agents
              </span>
            </div>

            <div className="swarm-grid" data-od-id="swarm-grid">
              {rows.map((a) => (
                <div className={`swarm-card ${needsAttention(a) ? "is-attention" : ""}`} key={a.id}>
                  <button type="button" className="swarm-card-main" onClick={() => openAgent(a.id)}>
                    <div className="fc-top">
                      <span className="fc-avatar">{a.name.charAt(0).toUpperCase()}</span>
                      <span className="fc-meta">
                        <span className="fc-name">{a.name}</span>
                        <span className="fc-role">{a.role || "—"}</span>
                      </span>
                      <span className="fc-status" data-st={a.status}>
                        {STATUS_LABEL[a.status] ?? a.status}
                      </span>
                    </div>
                    <div className="fc-task">
                      {a.currentNode ? (
                        <>
                          Working on <b>{a.currentNode}</b>
                          {a.task ? ` — ${a.task}` : ""}
                        </>
                      ) : (
                        a.task || <span className="fc-dim">No task set</span>
                      )}
                    </div>
                    <div className="fc-foot">
                      <span>{a.focus || "—"}</span>
                    </div>
                  </button>
                  <div className="card-actions">
                    <button className="card-act" type="button" aria-label={`Edit ${a.name}`} title="Edit" onClick={() => setFormAgentId(a.id)}>
                      <IconEdit />
                    </button>
                    <button
                      className="card-act card-act-del"
                      type="button"
                      aria-label={`Delete ${a.name}`}
                      title="Delete"
                      onClick={() => {
                        setDeleteError(null);
                        setDeleting(a);
                      }}
                    >
                      <IconTrash />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {!empty ? <SwarmActivityStream variant="swarm" /> : null}
      </div>

      {formAgentId !== undefined ? (
        <AgentForm agentId={formAgentId ?? undefined} onClose={() => setFormAgentId(undefined)} onSaved={onSaved} />
      ) : null}

      {deleting ? (
        <Modal labelledBy="del-title" onClose={() => setDeleting(null)}>
            <h3 id="del-title">Delete {deleting.name}?</h3>
            <p>
              This removes the agent, its configuration, and its saved conversations. This cannot be undone.
            </p>
            {deleteError ? <div className="cfg-error">{deleteError}</div> : null}
            <div className="cfg-modal-actions">
              <button type="button" className="reg-btn" onClick={() => setDeleting(null)}>
                Cancel
              </button>
              <button type="button" className="cfg-danger-btn" onClick={() => void confirmDelete()}>
                Delete agent
              </button>
            </div>
        </Modal>
      ) : null}
    </section>
  );
}
