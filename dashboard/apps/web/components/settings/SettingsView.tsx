"use client";

import { useCallback, useEffect, useState } from "react";
import { useTheme } from "@/components/providers/theme";
import {
  readConnection,
  saveConnection,
  listMcpServers,
  createMcpServer,
  updateMcpServer,
  deleteMcpServer,
  listMcpServerTools,
  listSkills,
  createSkill,
  updateSkill,
  deleteSkill,
  type McpServer,
  type Skill,
} from "@/lib/api";
import { IconPlus, IconClose } from "@/components/ui/icons";

interface ModelsResponse {
  models?: string[];
  default?: string;
}

export function SettingsView() {
  const { theme, toggle } = useTheme();
  const [model, setModel] = useState(() => readConnection().model);
  const [status, setStatus] = useState(() => (readConnection().model ? "Model override set" : "Server default"));
  const [saved, setSaved] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [serverDefault, setServerDefault] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/models")
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((data: ModelsResponse) => {
        if (cancelled) return;
        setModels(Array.isArray(data.models) ? data.models : []);
        setServerDefault(typeof data.default === "string" ? data.default : "");
      })
      .catch(() => {
        /* leave the text field in place */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const onSave = () => {
    saveConnection({ model: model.trim() });
    setStatus("Saved");
    setSaved(true);
    setTimeout(() => setStatus(model.trim() ? "Model override set" : "Server default"), 1400);
  };

  const options = model && !models.includes(model) ? [model, ...models] : models;
  const useSelect = models.length > 0;

  return (
    <section className="view active" data-od-id="view-settings">
      <div className="settings-index">
        <div className="panel-header">
          <h2>Settings</h2>
          <div className="graph-meta">
            <span>Connection, MCP servers &amp; skills</span>
          </div>
        </div>
        <div className="settings-body">
          <div className="panel-header sub">
            <h2>AI connection</h2>
            <span className={`cs-status ${saved ? "saved" : ""}`} aria-live="polite">
              {status}
            </span>
          </div>
          <label className="cs-field">
            <span className="cs-label">Model</span>
            {useSelect ? (
              <select value={model} onChange={(e) => setModel(e.target.value)}>
                <option value="">Auto — {serverDefault || "server default"}</option>
                {options.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                placeholder="auto-detect"
                spellCheck={false}
                autoComplete="off"
                value={model}
                onChange={(e) => setModel(e.target.value)}
              />
            )}
          </label>
          <p className="act-sub" style={{ marginTop: -2 }}>
            Agent chat and research stream through this server, which holds the API key — it never reaches the browser.
            {useSelect
              ? " Pick a model, or leave it on Auto to use the server's detected default."
              : " The model must be one your server's endpoint serves; leave it blank to auto-detect."}
          </p>
          <div className="cs-foot">
            <button className="cs-save" type="button" data-od-id="st-save" onClick={onSave}>
              Save connection
            </button>
          </div>

          <McpRegistry />
          <SkillRegistry />

          <div className="panel-header sub">
            <h2>Appearance</h2>
          </div>
          <div className="settings-rows">
            <div className="setting-row">
              <span className="sr-name">Theme</span>
              <button className="setting-action" type="button" onClick={toggle}>
                {theme === "light" ? "Light" : "Dark"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * MCP server registry
 * ------------------------------------------------------------------ */
function McpRegistry() {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Record<string, string>>({});

  const refresh = useCallback(() => {
    listMcpServers().then(setServers).catch(() => {});
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const onAdd = async () => {
    if (!name.trim() || !url.trim() || busy) return;
    setBusy(true);
    try {
      await createMcpServer({ name: name.trim(), url: url.trim(), apiKey: apiKey.trim() || undefined });
      setName("");
      setUrl("");
      setApiKey("");
      refresh();
    } catch {
      setPreview((p) => ({ ...p, _add: "Could not add server (check the URL)." }));
    } finally {
      setBusy(false);
    }
  };

  const onTest = async (id: string) => {
    setPreview((p) => ({ ...p, [id]: "Connecting…" }));
    try {
      const tools = await listMcpServerTools(id);
      setPreview((p) => ({ ...p, [id]: tools.length ? `${tools.length} tools: ${tools.map((t) => t.name.replace(/^mcp__[^_]+__/, "")).join(", ")}` : "No tools" }));
    } catch (err) {
      setPreview((p) => ({ ...p, [id]: err instanceof Error ? err.message : "Connection failed" }));
    }
  };

  return (
    <>
      <div className="panel-header sub">
        <h2>MCP servers</h2>
      </div>
      <div className="settings-rows">
        {servers.length ? (
          servers.map((s) => (
            <div className="reg-item" key={s.id}>
              <div className="reg-main">
                <span className="reg-name">{s.name}</span>
                <span className="reg-sub">{s.url}{s.hasKey ? " · key set" : ""}</span>
                {preview[s.id] ? <span className="reg-preview">{preview[s.id]}</span> : null}
              </div>
              <div className="reg-actions">
                <button className="reg-btn" type="button" onClick={() => void onTest(s.id)}>
                  Test
                </button>
                <button
                  className="reg-btn"
                  type="button"
                  onClick={() => void updateMcpServer({ id: s.id, enabled: !s.enabled }).then(refresh)}
                >
                  {s.enabled ? "Disable" : "Enable"}
                </button>
                <button
                  className="reg-del"
                  type="button"
                  aria-label="Delete MCP server"
                  onClick={() => void deleteMcpServer(s.id).then(refresh)}
                >
                  <IconClose />
                </button>
              </div>
            </div>
          ))
        ) : (
          <p className="act-sub">No MCP servers yet. Add a streamable-HTTP server below; then enable it per agent in that agent&rsquo;s Config tab.</p>
        )}
      </div>
      <div className="reg-form">
        <input className="reg-input" aria-label="MCP server name" placeholder="name" value={name} spellCheck={false} onChange={(e) => setName(e.target.value)} />
        <input className="reg-input" aria-label="MCP server URL" placeholder="https://mcp.example.com/mcp" value={url} spellCheck={false} autoComplete="off" onChange={(e) => setUrl(e.target.value)} />
        <input className="reg-input" type="password" aria-label="Bearer token (optional)" placeholder="bearer token (optional)" value={apiKey} spellCheck={false} autoComplete="off" onChange={(e) => setApiKey(e.target.value)} />
        <button className="reg-add" type="button" onClick={() => void onAdd()} disabled={busy || !name.trim() || !url.trim()}>
          <IconPlus />
          Add server
        </button>
      </div>
      {preview._add ? <p className="reg-err">{preview._add}</p> : null}
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Skill registry
 * ------------------------------------------------------------------ */
function SkillRegistry() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(() => {
    listSkills().then(setSkills).catch(() => {});
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const onAdd = async () => {
    if (!name.trim() || !content.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await createSkill({ name: name.trim(), description: description.trim(), content });
      setName("");
      setDescription("");
      setContent("");
      refresh();
    } catch {
      setErr("Could not save skill.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="panel-header sub">
        <h2>Skills</h2>
      </div>
      <div className="settings-rows">
        {skills.length ? (
          skills.map((k) => (
            <div className="reg-item" key={k.id}>
              <div className="reg-main">
                <span className="reg-name">{k.name}</span>
                <span className="reg-sub">{k.description || "(no description)"}{k.enabled ? "" : " · disabled"}</span>
              </div>
              <div className="reg-actions">
                <button
                  className="reg-btn"
                  type="button"
                  onClick={() => void updateSkill({ id: k.id, enabled: !k.enabled }).then(refresh)}
                >
                  {k.enabled ? "Disable" : "Enable"}
                </button>
                <button
                  className="reg-del"
                  type="button"
                  aria-label="Delete skill"
                  onClick={() => void deleteSkill(k.id).then(refresh)}
                >
                  <IconClose />
                </button>
              </div>
            </div>
          ))
        ) : (
          <p className="act-sub">No skills yet. A skill is instruction text injected into an agent&rsquo;s prompt when you attach it in that agent&rsquo;s Config tab.</p>
        )}
      </div>
      <div className="reg-form reg-form-skill">
        <input className="reg-input" aria-label="Skill name" placeholder="name" value={name} spellCheck={false} onChange={(e) => setName(e.target.value)} />
        <input className="reg-input" aria-label="Skill description" placeholder="description" value={description} spellCheck={false} onChange={(e) => setDescription(e.target.value)} />
        <textarea
          className="reg-textarea"
          aria-label="Skill instructions (markdown)"
          placeholder="skill instructions (markdown)"
          rows={3}
          value={content}
          spellCheck={false}
          onChange={(e) => setContent(e.target.value)}
        />
        <button className="reg-add" type="button" onClick={() => void onAdd()} disabled={busy || !name.trim() || !content.trim()}>
          <IconPlus />
          Add skill
        </button>
      </div>
      {err ? <p className="reg-err">{err}</p> : null}
    </>
  );
}
