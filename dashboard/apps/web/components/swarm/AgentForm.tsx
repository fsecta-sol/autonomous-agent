"use client";

import { useEffect, useState } from "react";
import {
  createAgentRecord,
  updateAgentRecord,
  getAgentRecord,
  getToolCatalog,
  listMcpServers,
  listSkills,
  type AgentRecord,
  type AgentStatus,
  type ToolInfo,
  type McpServer,
  type Skill,
  type TerminalMode,
} from "@/lib/api";
import { IconClose } from "@/components/ui/icons";
import { Modal } from "@/components/ui/Modal";

const BLANK: AgentRecord = {
  name: "",
  role: "",
  status: "idle",
  currentNode: "",
  task: "",
  focus: "",
  model: "",
  apiUrl: "",
  apiKey: "",
  tools: null,
  skills: [],
  mcpServers: [],
  terminalMode: "off",
};

const STATUSES: AgentStatus[] = ["working", "analysing", "idle", "pending"];
const TERMINALS: [TerminalMode, string][] = [
  ["off", "Off"],
  ["sandbox", "Sandboxed"],
  ["unsandboxed", "Unsandboxed"],
];

/**
 * Create or edit one agent: identity, its own model/endpoint/key, and its
 * capabilities (tools, skills, MCP servers, terminal). `agentId` undefined
 * means create. The key is write-only — a blank field keeps the stored one.
 */
export function AgentForm({ agentId, onClose, onSaved }: { agentId?: string; onClose: () => void; onSaved: () => void }) {
  const editing = !!agentId;
  const [form, setForm] = useState<AgentRecord>(BLANK);
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [servers, setServers] = useState<McpServer[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [allowUnsandboxed, setAllowUnsandboxed] = useState(false);
  const [loading, setLoading] = useState(editing);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmUnsafe, setConfirmUnsafe] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [catalog, s, k, rec] = await Promise.all([
          getToolCatalog(),
          listMcpServers(),
          listSkills(),
          agentId ? getAgentRecord(agentId) : Promise.resolve(BLANK),
        ]);
        if (cancelled) return;
        setTools(catalog.tools);
        setAllowUnsandboxed(catalog.allowUnsandboxed);
        setServers(s);
        setSkills(k);
        setForm(rec);
      } catch {
        if (!cancelled) setError("Could not load the form.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  const set = <K extends keyof AgentRecord>(k: K, v: AgentRecord[K]) => setForm((f) => ({ ...f, [k]: v }));
  const toggleIn = <K extends "skills" | "mcpServers">(k: K, id: string) => {
    const set0 = new Set(form[k]);
    if (set0.has(id)) set0.delete(id);
    else set0.add(id);
    set(k, [...set0]);
  };

  const usingDefaultTools = form.tools === null;
  const toolChecked = (name: string) => (form.tools === null ? tools.find((t) => t.name === name)?.enabledByDefault ?? false : form.tools.includes(name));
  const toggleTool = (name: string) => {
    const base = new Set(form.tools ?? tools.filter((t) => t.enabledByDefault).map((t) => t.name));
    if (base.has(name)) base.delete(name);
    else base.add(name);
    set("tools", [...base]);
  };

  const chooseTerminal = (mode: TerminalMode) => {
    if (mode === "unsandboxed" && form.terminalMode !== "unsandboxed" && !confirmUnsafe) {
      set("terminalMode", mode);
      setConfirmUnsafe(true);
      return;
    }
    set("terminalMode", mode);
  };

  const save = async () => {
    if (!form.name.trim()) {
      setError("Give the agent a name.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (editing && agentId) await updateAgentRecord(agentId, form);
      else await createAgentRecord(form);
      onSaved();
    } catch {
      setError("Could not save the agent.");
      setBusy(false);
    }
  };

  return (
    <>
      <Modal labelledBy="af-title" onClose={onClose} overlayClassName="af-overlay" boxClassName="af-modal">
        <div className="af-head">
          <h2 id="af-title">{editing ? "Edit agent" : "New agent"}</h2>
          <button className="af-close" type="button" aria-label="Close" onClick={onClose}>
            <IconClose />
          </button>
        </div>

        {loading ? (
          <div className="af-body">
            <div className="activity-empty">Loading…</div>
          </div>
        ) : (
          <div className="af-body">
            <section className="af-sec">
              <h3>Identity</h3>
              <div className="af-grid">
                <label className="af-field af-span2">
                  <span className="af-label">Name</span>
                  <input value={form.name} placeholder="e.g. Kai" onChange={(e) => set("name", e.target.value)} />
                </label>
                <label className="af-field">
                  <span className="af-label">Role</span>
                  <input value={form.role} placeholder="Research" onChange={(e) => set("role", e.target.value)} />
                </label>
                <label className="af-field">
                  <span className="af-label">Status</span>
                  <select value={form.status} onChange={(e) => set("status", e.target.value as AgentStatus)}>
                    {STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="af-field">
                  <span className="af-label">Current node</span>
                  <input value={form.currentNode} placeholder="graph node title" onChange={(e) => set("currentNode", e.target.value)} />
                </label>
                <label className="af-field">
                  <span className="af-label">Focus</span>
                  <input value={form.focus} placeholder="what it watches" onChange={(e) => set("focus", e.target.value)} />
                </label>
                <label className="af-field af-span2">
                  <span className="af-label">Current task</span>
                  <input value={form.task} placeholder="what it is doing now" onChange={(e) => set("task", e.target.value)} />
                </label>
              </div>
            </section>

            <section className="af-sec">
              <h3>Connection</h3>
              <p className="af-note">Leave blank to use the server&rsquo;s endpoint and key. Set these to point this agent at its own provider.</p>
              <div className="af-grid">
                <label className="af-field af-span2">
                  <span className="af-label">Endpoint URL</span>
                  <input
                    type="url"
                    value={form.apiUrl}
                    placeholder="https://api.example.com/v1"
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(e) => set("apiUrl", e.target.value)}
                  />
                </label>
                <label className="af-field">
                  <span className="af-label">API key</span>
                  <input
                    type="password"
                    value={form.apiKey}
                    placeholder={form.hasKey ? "•••• set — blank keeps it" : "sk-…"}
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(e) => set("apiKey", e.target.value)}
                  />
                </label>
                <label className="af-field">
                  <span className="af-label">Model</span>
                  <input
                    type="text"
                    value={form.model}
                    placeholder="auto (server default)"
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(e) => set("model", e.target.value)}
                  />
                </label>
              </div>
            </section>

            <section className="af-sec">
              <h3>Tools</h3>
              <div className="af-inline">
                <button type="button" className={`cfg-reset ${usingDefaultTools ? "is-on" : ""}`} onClick={() => set("tools", null)}>
                  Use server defaults
                </button>
              </div>
              <div className="af-checks">
                {tools.map((t) => (
                  <label className="cfg-row af-check" key={t.name}>
                    <input type="checkbox" checked={toolChecked(t.name)} onChange={() => toggleTool(t.name)} />
                    <span className="cfg-name">{t.name}</span>
                    <span className="cfg-desc">{t.description}</span>
                  </label>
                ))}
              </div>
            </section>

            <section className="af-sec">
              <h3>MCP servers</h3>
              {servers.length ? (
                <div className="af-checks">
                  {servers.map((s) => (
                    <label className="cfg-row af-check" key={s.id}>
                      <input type="checkbox" checked={form.mcpServers.includes(s.id)} onChange={() => toggleIn("mcpServers", s.id)} />
                      <span className="cfg-name">{s.name}</span>
                      <span className="cfg-desc">{s.url}</span>
                    </label>
                  ))}
                </div>
              ) : (
                <p className="af-note">No MCP servers registered — add them in Settings.</p>
              )}
            </section>

            <section className="af-sec">
              <h3>Skills</h3>
              {skills.length ? (
                <div className="af-checks">
                  {skills.map((k) => (
                    <label className="cfg-row af-check" key={k.id}>
                      <input type="checkbox" checked={form.skills.includes(k.id)} onChange={() => toggleIn("skills", k.id)} />
                      <span className="cfg-name">{k.name}</span>
                      <span className="cfg-desc">{k.description || "(no description)"}</span>
                    </label>
                  ))}
                </div>
              ) : (
                <p className="af-note">No skills registered — add them in Settings.</p>
              )}
            </section>

            <section className="af-sec">
              <h3>Terminal</h3>
              <div className="cfg-modes" role="radiogroup" aria-label="Terminal mode">
                {TERMINALS.map(([mode, label]) => (
                  <button
                    type="button"
                    key={mode}
                    role="radio"
                    aria-checked={form.terminalMode === mode}
                    className={`cfg-mode ${form.terminalMode === mode ? "is-on" : ""} ${mode === "unsandboxed" ? "is-danger" : ""}`}
                    disabled={mode === "unsandboxed" && !allowUnsandboxed}
                    title={mode === "unsandboxed" && !allowUnsandboxed ? "Disabled: server does not permit unsandboxed execution" : undefined}
                    onClick={() => chooseTerminal(mode)}
                  >
                    <span className="cm-label">{label}</span>
                  </button>
                ))}
              </div>
              {form.terminalMode === "unsandboxed" ? (
                <div className="cfg-danger" role="alert">
                  <b>Unsandboxed.</b> Commands run as the server user with full filesystem and network access.
                </div>
              ) : null}
            </section>

            {error ? <div className="cfg-error">{error}</div> : null}
          </div>
        )}

        <div className="af-foot">
          <button className="reg-btn" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="cs-save af-save" type="button" onClick={() => void save()} disabled={busy || loading}>
            {busy ? "Saving…" : editing ? "Save changes" : "Create agent"}
          </button>
        </div>
      </Modal>

      {confirmUnsafe ? (
        <Modal labelledBy="af-unsafe" onClose={() => setConfirmUnsafe(false)}>
            <h3 id="af-unsafe">Enable unsandboxed terminal?</h3>
            <p>
              This agent&rsquo;s commands will run <b>without any sandbox</b> — full access to this server&rsquo;s files
              (including secrets) and network. Only continue if you intend that.
            </p>
            <div className="cfg-modal-actions">
              <button type="button" className="reg-btn" onClick={() => { set("terminalMode", "sandbox"); setConfirmUnsafe(false); }}>
                Cancel
              </button>
              <button type="button" className="cfg-danger-btn" onClick={() => setConfirmUnsafe(false)}>
                I understand
              </button>
            </div>
        </Modal>
      ) : null}
    </>
  );
}
