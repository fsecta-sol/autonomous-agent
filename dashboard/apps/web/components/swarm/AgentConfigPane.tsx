"use client";

import { useEffect, useState } from "react";
import {
  getAgentConfig,
  saveAgentConfig,
  getToolCatalog,
  listMcpServers,
  listSkills,
  type ToolInfo,
  type McpServer,
  type Skill,
  type TerminalMode,
} from "@/lib/api";
import { IconCheck } from "@/components/ui/icons";
import { Modal } from "@/components/ui/Modal";

/**
 * Per-agent configuration: which builtin tools, skills, and MCP servers this
 * agent may use. Config is stored server-side per agent (not per chat session),
 * so every conversation with the agent inherits it.
 */
export function AgentConfigPane({ agentId }: { agentId: string }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [servers, setServers] = useState<McpServer[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);

  // selection (null tools = "all defaults")
  const [toolSel, setToolSel] = useState<Set<string> | null>(null);
  const [mcpSel, setMcpSel] = useState<Set<string>>(new Set());
  const [skillSel, setSkillSel] = useState<Set<string>>(new Set());
  const [terminalMode, setTerminalMode] = useState<TerminalMode>("off");
  const [allowUnsandboxed, setAllowUnsandboxed] = useState(false);
  const [confirmUnsafe, setConfirmUnsafe] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [cfg, catalog, s, k] = await Promise.all([
          getAgentConfig(agentId),
          getToolCatalog(),
          listMcpServers(),
          listSkills(),
        ]);
        if (cancelled) return;
        setTools(catalog.tools);
        setAllowUnsandboxed(catalog.allowUnsandboxed);
        setServers(s);
        setSkills(k);
        setToolSel(cfg.tools === null ? null : new Set(cfg.tools));
        setMcpSel(new Set(cfg.mcpServers));
        setSkillSel(new Set(cfg.skills));
        setTerminalMode(cfg.terminalMode ?? "off");
      } catch {
        if (!cancelled) setError("Could not load the agent's configuration.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  const toggle = (set: Set<string>, id: string, apply: (s: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    apply(next);
  };

  // When tools are on "defaults", reflect the defaults as checked but read-only-ish:
  // any explicit toggle switches to an explicit set seeded from the defaults.
  const effectiveToolSel = toolSel ?? new Set(tools.filter((t) => t.enabledByDefault).map((t) => t.name));
  const usingDefaults = toolSel === null;

  const onToggleTool = (name: string) => {
    const base = new Set(effectiveToolSel);
    if (base.has(name)) base.delete(name);
    else base.add(name);
    setToolSel(base);
    setSaved(false);
  };

  const onSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const cfg = await saveAgentConfig(agentId, {
        tools: usingDefaults ? null : [...effectiveToolSel],
        mcpServers: [...mcpSel],
        skills: [...skillSel],
        terminalMode,
      });
      setToolSel(cfg.tools === null ? null : new Set(cfg.tools));
      setTerminalMode(cfg.terminalMode ?? "off");
      setSaved(true);
      setTimeout(() => setSaved(false), 1600);
    } catch {
      setError("Could not save the configuration.");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="chat-pane active" role="tabpanel" id="panel-config" aria-labelledby="tab-config">
        <div className="activity-empty">Loading configuration…</div>
      </div>
    );
  }

  const changingTerminal = (mode: TerminalMode) => {
    setSaved(false);
    if (mode === "unsandboxed" && terminalMode !== "unsandboxed") {
      setTerminalMode(mode);
      setConfirmUnsafe(true); // require an explicit confirm before saving this
    } else {
      setTerminalMode(mode);
    }
  };

  return (
    <div className="chat-pane active" role="tabpanel" id="panel-config" aria-labelledby="tab-config" data-od-id="agent-config">
      <div className="cfg-pane">
        <div className="cfg-sec">
          <div className="cfg-head">
            <h3>Terminal</h3>
          </div>
          <div className="cfg-modes" role="radiogroup" aria-label="Terminal mode">
            {(
              [
                ["off", "Off", "No shell access."],
                ["sandbox", "Sandboxed", "Isolated: no network, files limited to a scratch dir."],
                ["unsandboxed", "Unsandboxed", "Full access to this server's filesystem and network."],
              ] as [TerminalMode, string, string][]
            ).map(([mode, label, hint]) => (
              <button
                type="button"
                key={mode}
                role="radio"
                aria-checked={terminalMode === mode}
                className={`cfg-mode ${terminalMode === mode ? "is-on" : ""} ${mode === "unsandboxed" ? "is-danger" : ""}`}
                disabled={mode === "unsandboxed" && !allowUnsandboxed}
                title={mode === "unsandboxed" && !allowUnsandboxed ? "Disabled: server does not permit unsandboxed execution" : hint}
                onClick={() => changingTerminal(mode)}
              >
                <span className="cm-label">{label}</span>
                <span className="cm-hint">{hint}</span>
              </button>
            ))}
          </div>
          {terminalMode === "unsandboxed" ? (
            <div className="cfg-danger" role="alert">
              <b>Unsandboxed.</b> Commands run as the server user with full filesystem and network access — they can read
              secrets, modify or delete files, and reach the network. Only enable this for an agent you trust with this host.
            </div>
          ) : null}
          {!allowUnsandboxed ? (
            <p className="cfg-hint">Unsandboxed mode is disabled on this server (set <code>TERMINAL_ALLOW_UNSANDBOXED=1</code> to permit it).</p>
          ) : null}
        </div>

        <div className="cfg-sec">
          <div className="cfg-head">
            <h3>Tools</h3>
            <button
              type="button"
              className={`cfg-reset ${usingDefaults ? "is-on" : ""}`}
              onClick={() => {
                setToolSel(null);
                setSaved(false);
              }}
            >
              Use server defaults
            </button>
          </div>
          {tools.length ? (
            tools.map((t) => (
              <label className="cfg-row" key={t.name}>
                <input type="checkbox" checked={effectiveToolSel.has(t.name)} onChange={() => onToggleTool(t.name)} />
                <span className="cfg-name">{t.name}</span>
                <span className="cfg-desc">{t.description}</span>
              </label>
            ))
          ) : (
            <div className="activity-empty">No builtin tools registered.</div>
          )}
        </div>

        <div className="cfg-sec">
          <div className="cfg-head">
            <h3>MCP servers</h3>
          </div>
          {servers.length ? (
            servers.map((s) => (
              <label className="cfg-row" key={s.id}>
                <input type="checkbox" checked={mcpSel.has(s.id)} onChange={() => { toggle(mcpSel, s.id, setMcpSel); setSaved(false); }} />
                <span className="cfg-name">{s.name}</span>
                <span className="cfg-desc">{s.url}{s.enabled ? "" : " · disabled"}</span>
              </label>
            ))
          ) : (
            <div className="activity-empty">No MCP servers registered — add one in Settings.</div>
          )}
        </div>

        <div className="cfg-sec">
          <div className="cfg-head">
            <h3>Skills</h3>
          </div>
          {skills.length ? (
            skills.map((k) => (
              <label className="cfg-row" key={k.id}>
                <input type="checkbox" checked={skillSel.has(k.id)} onChange={() => { toggle(skillSel, k.id, setSkillSel); setSaved(false); }} />
                <span className="cfg-name">{k.name}</span>
                <span className="cfg-desc">{k.description || "(no description)"}{k.enabled ? "" : " · disabled"}</span>
              </label>
            ))
          ) : (
            <div className="activity-empty">No skills registered — add one in Settings.</div>
          )}
        </div>

        {error ? <div className="cfg-error">{error}</div> : null}
        <div className="cfg-foot">
          <button className="cs-save" type="button" onClick={() => void onSave()} disabled={saving}>
            {saving ? "Saving…" : saved ? (
              <>
                <IconCheck /> Saved
              </>
            ) : (
              "Save configuration"
            )}
          </button>
          {usingDefaults ? <span className="cfg-note">Using server default tools.</span> : <span className="cfg-note">Explicit tool set.</span>}
        </div>
      </div>

      {confirmUnsafe ? (
        <Modal labelledBy="unsafe-title" onClose={() => setConfirmUnsafe(false)}>
            <h3 id="unsafe-title">Enable unsandboxed terminal?</h3>
            <p>
              This agent&rsquo;s commands will run <b>without any sandbox</b>, as the server user: full access to this
              machine&rsquo;s files (including secrets), and the network. Only continue if you intend the agent to have
              that access. Save to apply.
            </p>
            <div className="cfg-modal-actions">
              <button
                type="button"
                className="reg-btn"
                onClick={() => {
                  setTerminalMode("sandbox");
                  setConfirmUnsafe(false);
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="cfg-danger-btn"
                onClick={() => {
                  setConfirmUnsafe(false);
                }}
              >
                I understand — keep unsandboxed
              </button>
            </div>
        </Modal>
      ) : null}
    </div>
  );
}
