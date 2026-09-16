import { LlmError } from "./llm-client";
import { streamChatRequest, streamAttachRequest, type StreamHandlers } from "./llm-stream";
import type { Agent, ActivityDay, KnowledgeSource, PipelineRun, SpawnEvent, SwarmTelemetry } from "@dashboard/shared";
import { ACTIVITY_DAYS, CRON } from "./store";
import { buildGraphData, type GraphData } from "@dashboard/shared";

/**
 * The single seam between UI and backend. Today every call resolves from
 * local mock data; when a backend exists, each function body becomes an
 * llmJson/fetch call against the same return type. Components never import
 * mock data directly — they await these.
 */

let cachedGraph: GraphData | null = null;

export async function fetchGraphData(): Promise<GraphData> {
  if (!cachedGraph) {
    cachedGraph = buildGraphData();
  }
  // one microtask so callers always observe a pending state
  await Promise.resolve();
  return cachedGraph;
}

export async function fetchAgents(): Promise<Agent[]> {
  const data = await jsonOrThrow<{ agents: Agent[] }>(await fetch("/api/agents"));
  return data.agents;
}

/**
 * The swarm's derived runtime telemetry (heartbeat, uptime, queue, error rate,
 * throughput, latency). Every figure is measured by the backend, not mocked.
 * Throws on failure so a poller can mark the feed offline.
 */
export async function fetchTelemetry(signal?: AbortSignal): Promise<SwarmTelemetry> {
  const res = await fetch("/api/telemetry", { signal, cache: "no-store" });
  return jsonOrThrow<SwarmTelemetry>(res);
}

export async function fetchActivityDays(): Promise<ActivityDay[]> {
  await Promise.resolve();
  return ACTIVITY_DAYS;
}

export async function fetchPipelines(): Promise<PipelineRun[]> {
  await Promise.resolve();
  return CRON;
}

export async function fetchSources(): Promise<KnowledgeSource[]> {
  await Promise.resolve();
  return [
    { id: "s1", label: "mev-brief.md", kind: "inbox", addedAt: "05 Sep 2026" },
    { id: "s2", label: "nightly-auto-digest.md", kind: "inbox", addedAt: "05 Sep 2026" },
    { id: "s3", label: "curated research feed", kind: "curated", addedAt: "04 Sep 2026" },
    { id: "s4", label: "protocol documentation set", kind: "curated", addedAt: "04 Sep 2026" },
    { id: "s5", label: "project intake queue", kind: "project", addedAt: "03 Sep 2026" },
    { id: "s6", label: "topology audit reports", kind: "analysis", addedAt: "03 Sep 2026" },
  ];
}

export interface ResearchRequest {
  thought: string;
  depth: "quick" | "standard" | "deep";
}

export interface ResearchResponse {
  summary: string;
  connections: string[];
  layer: string | null;
}

/**
 * Runs a research thought through the server's LLM proxy. When the server has
 * no LLM key configured it answers 501; we surface that as a status-less
 * "no connection" error so callers fall back to the local vault matcher.
 */
export async function runResearch(req: ResearchRequest, signal?: AbortSignal): Promise<ResearchResponse> {
  let res: Response;
  try {
    res = await fetch("/api/research", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
      signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new LlmError("aborted", "Request cancelled", 1);
    }
    throw new LlmError("network", `Network error: ${String(err)}`, 1);
  }
  if (res.status === 501) {
    throw new LlmError("http", "No AI connection configured. Add one in Settings → AI connection.", 1);
  }
  if (!res.ok) {
    throw new LlmError("http", `Request failed with HTTP ${res.status}`, 1, res.status);
  }
  return (await res.json()) as ResearchResponse;
}

/** Only the model override is kept client-side now — the key lives on the server. */
export interface AgentConnection {
  model: string;
}

export function readConnection(): AgentConnection {
  try {
    const c = JSON.parse(localStorage.getItem("agent-conn") || "{}");
    return { model: c.model || "" };
  } catch {
    return { model: "" };
  }
}

export function saveConnection(conn: AgentConnection): void {
  localStorage.setItem("agent-conn", JSON.stringify({ model: conn.model }));
}

/** The models an endpoint serves, and the one it would default to. */
export interface ModelsResponse {
  models: string[];
  /** the server's default model (env value, or the endpoint's auto-pick) */
  default: string;
  source: "env" | "auto" | "none";
  /** when the list could not be read (e.g. the endpoint is unreachable) */
  detail?: string;
}

/**
 * List the models the endpoint serves. With `agentId` the backend resolves that
 * agent's own endpoint + key first, so an agent on its own provider lists its
 * models rather than the server's. Resolves to an empty list on failure (never
 * throws) so a picker can fall back to a free-text field.
 */
export async function fetchModels(agentId?: string): Promise<ModelsResponse> {
  const url = agentId ? `/api/models?agentId=${encodeURIComponent(agentId)}` : "/api/models";
  try {
    const res = await fetch(url);
    if (!res.ok) return { models: [], default: "", source: "none" };
    const data = (await res.json()) as Partial<ModelsResponse>;
    return {
      models: Array.isArray(data.models) ? data.models.filter((m): m is string => typeof m === "string") : [],
      default: typeof data.default === "string" ? data.default : "",
      source: data.source === "env" || data.source === "auto" ? data.source : "none",
      detail: typeof data.detail === "string" ? data.detail : undefined,
    };
  } catch {
    return { models: [], default: "", source: "none" };
  }
}

export interface ChatTurn {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface StreamChatRequest {
  agentId: string;
  /** optional model override; the server falls back to LLM_MODEL */
  model?: string;
  messages: ChatTurn[];
  /** the chat session; the server uses it as the durable thread id and reads
   *  its own persisted transcript from it */
  sessionId?: string;
  /** answer a paused run's approval interrupt instead of sending a new turn */
  resume?: { id?: string; decision: "approve" | "deny" };
  /** ask the model to work through the problem step by step */
  reasoning?: boolean;
  /** run a deeper, source-seeking pass before answering */
  research?: boolean;
}

/**
 * Streams a chat completion through the server proxy. Text deltas arrive on
 * `onText`; as the agent runs tools, `onTool` fires for each start/end. Which
 * tools are available is the agent's server-side configuration, not a client
 * choice. When a run pauses for approval, `onInterrupt` fires and the stream
 * ends; resume with a new call carrying `resume`. The API key never leaves the
 * server; this is a same-origin call. Throws an {@link LlmError} with
 * `status === 501` when the server has no key.
 */
export async function streamAgentChat(req: StreamChatRequest, handlers: StreamHandlers): Promise<void> {
  // An explicit "" means "no override" (the server then uses the session's own
  // choice, else its default) — only an absent value falls back to the global
  // Settings model. `??` (not `||`) keeps that distinction.
  return streamChatRequest("/api/chat", { ...req, model: req.model ?? readConnection().model }, handlers);
}

export interface ToolInfo {
  name: string;
  description: string;
  enabledByDefault: boolean;
}

export interface ToolCatalog {
  tools: ToolInfo[];
  /** whether this server permits unsandboxed terminal execution at all */
  allowUnsandboxed: boolean;
}

/** The builtin tools the server can run, plus the unsandboxed-terminal gate. */
export async function getToolCatalog(): Promise<ToolCatalog> {
  const data = await jsonOrThrow<{ tools: ToolInfo[]; allowUnsandboxed?: boolean }>(await fetch("/api/tools"));
  return { tools: data.tools, allowUnsandboxed: !!data.allowUnsandboxed };
}

/* ------------------------------------------------------------------ *
 * Agents — the roster is data now (create, edit, delete in the UI)
 * ------------------------------------------------------------------ */

export type AgentStatus = "working" | "analysing" | "idle" | "pending";

/** The combined record the create/edit form reads and writes. apiKey is write-only. */
export interface AgentRecord {
  id?: string;
  name: string;
  role: string;
  status: AgentStatus;
  currentNode: string;
  task: string;
  focus: string;
  /** per-agent model override ("" = server default) */
  model: string;
  /** per-agent provider endpoint ("" = use server env) */
  apiUrl: string;
  /** a NEW key to store; on edit, "" leaves the existing key unchanged */
  apiKey: string;
  /** true when the server already holds a key for this agent */
  hasKey?: boolean;
  tools: string[] | null;
  skills: string[];
  mcpServers: string[];
  terminalMode: TerminalMode;
}

export async function getAgentRecord(id: string): Promise<AgentRecord> {
  const d = await jsonOrThrow<AgentRecord & { hasKey: boolean }>(await fetch(`/api/agents/${encodeURIComponent(id)}`));
  return { ...d, apiKey: "" };
}

/** The POST/PATCH body: apiKey is omitted when empty so an edit never wipes it. */
function agentBody(v: AgentRecord): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: v.name,
    role: v.role,
    status: v.status,
    currentNode: v.currentNode.trim() || null,
    task: v.task,
    focus: v.focus,
    model: v.model.trim() || null,
    apiUrl: v.apiUrl.trim() || null,
    tools: v.tools,
    skills: v.skills,
    mcpServers: v.mcpServers,
    terminalMode: v.terminalMode,
  };
  if (v.apiKey.trim()) body.apiKey = v.apiKey.trim();
  return body;
}

export async function createAgentRecord(v: AgentRecord): Promise<{ id: string }> {
  const res = await fetch("/api/agents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(agentBody(v)),
  });
  return jsonOrThrow<{ id: string }>(res);
}

export async function updateAgentRecord(id: string, v: AgentRecord): Promise<void> {
  const res = await fetch(`/api/agents/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(agentBody(v)),
  });
  if (!res.ok) throw new Error(`Request failed with HTTP ${res.status}`);
}

export async function deleteAgentRecord(id: string): Promise<void> {
  const res = await fetch(`/api/agents/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Request failed with HTTP ${res.status}`);
}

/* ------------------------------------------------------------------ *
 * Per-agent configuration (tools, skills, MCP servers)
 * ------------------------------------------------------------------ */

export type TerminalMode = "off" | "sandbox" | "unsandboxed";

export interface AgentConfig {
  /** null = server defaults; a list = explicit builtin tool names */
  tools: string[] | null;
  skills: string[];
  mcpServers: string[];
  /** terminal access level for this agent */
  terminalMode: TerminalMode;
}

export async function getAgentConfig(agentId: string): Promise<AgentConfig> {
  return jsonOrThrow<AgentConfig>(await fetch(`/api/agents/${encodeURIComponent(agentId)}/config`));
}

export async function saveAgentConfig(agentId: string, patch: Partial<AgentConfig>): Promise<AgentConfig> {
  const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  return jsonOrThrow<AgentConfig>(res);
}

/* ------------------------------------------------------------------ *
 * MCP server registry (api_key is write-only)
 * ------------------------------------------------------------------ */

export interface McpServer {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  hasKey: boolean;
}

export async function listMcpServers(): Promise<McpServer[]> {
  const data = await jsonOrThrow<{ servers: McpServer[] }>(await fetch("/api/mcp/servers"));
  return data.servers;
}

export async function createMcpServer(input: { name: string; url: string; apiKey?: string }): Promise<McpServer> {
  const res = await fetch("/api/mcp/servers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return jsonOrThrow<McpServer>(res);
}

export async function updateMcpServer(patch: { id: string; name?: string; url?: string; apiKey?: string; enabled?: boolean }): Promise<void> {
  const res = await fetch("/api/mcp/servers", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`Request failed with HTTP ${res.status}`);
}

export async function deleteMcpServer(id: string): Promise<void> {
  const res = await fetch(`/api/mcp/servers?id=${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Request failed with HTTP ${res.status}`);
}

/** Live-connect to a server and preview the tool names it exports. */
export async function listMcpServerTools(id: string): Promise<ToolInfo[]> {
  const data = await jsonOrThrow<{ tools: ToolInfo[] }>(await fetch(`/api/mcp/servers/${encodeURIComponent(id)}/tools`));
  return data.tools;
}

/* ------------------------------------------------------------------ *
 * Skill registry
 * ------------------------------------------------------------------ */

export interface Skill {
  id: string;
  name: string;
  description: string;
  content: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export async function listSkills(): Promise<Skill[]> {
  const data = await jsonOrThrow<{ skills: Skill[] }>(await fetch("/api/skills"));
  return data.skills;
}

export async function createSkill(input: { name: string; description?: string; content: string }): Promise<Skill> {
  const res = await fetch("/api/skills", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return jsonOrThrow<Skill>(res);
}

export async function updateSkill(patch: { id: string; name?: string; description?: string; content?: string; enabled?: boolean }): Promise<void> {
  const res = await fetch("/api/skills", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`Request failed with HTTP ${res.status}`);
}

export async function deleteSkill(id: string): Promise<void> {
  const res = await fetch(`/api/skills?id=${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Request failed with HTTP ${res.status}`);
}

/* ------------------------------------------------------------------ *
 * Sessions (persistent chat history) — backed by SQLite via /api/chats.
 * ------------------------------------------------------------------ */

export interface ChatSession {
  id: string;
  agentId: string;
  title: string;
  model: string | null;
  pinned: boolean;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export interface ChatSessionMessage {
  id: string;
  role: "system" | "user" | "assistant";
  content: string;
  links: string[] | null;
  /** recorded SSE envelopes for this turn, so a reload can rebuild the trace */
  events: unknown[] | null;
  seq: number;
  createdAt: number;
}

export interface ChatSessionDetail extends ChatSession {
  messages: ChatSessionMessage[];
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    // surface the endpoint and the server's own message so a failure is
    // diagnosable instead of a bare status code
    let detail = "";
    try {
      const body = (await res.json()) as { error?: unknown; detail?: unknown };
      const parts = [body.error, body.detail].filter((x): x is string => typeof x === "string");
      if (parts.length) detail = ` — ${parts.join(": ")}`;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(`Request failed with HTTP ${res.status} (${res.url})${detail}`);
  }
  return (await res.json()) as T;
}

export async function listChats(agentId: string): Promise<ChatSession[]> {
  const res = await fetch(`/api/chats?agentId=${encodeURIComponent(agentId)}`);
  const data = await jsonOrThrow<{ sessions: ChatSession[] }>(res);
  return data.sessions;
}

export async function createChat(agentId: string, model?: string): Promise<ChatSessionDetail> {
  const res = await fetch("/api/chats", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentId, model }),
  });
  return jsonOrThrow<ChatSessionDetail>(res);
}

export async function getChat(id: string): Promise<ChatSessionDetail> {
  return jsonOrThrow<ChatSessionDetail>(await fetch(`/api/chats/${id}`));
}

/** A pending approval on a session's run, if it is paused. */
export interface ChatRunState {
  paused: boolean;
  interrupt: { id: string | null; tool: string | null; args: Record<string, unknown>; message: string } | null;
}

/** Whether this session's run is paused awaiting tool approval. */
export async function getChatState(id: string): Promise<ChatRunState> {
  return jsonOrThrow<ChatRunState>(await fetch(`/api/chats/${encodeURIComponent(id)}/state`));
}

/**
 * Attach to a session's in-flight run. The backend replays the run from its
 * start (so a reload re-renders the steps already taken) and then follows it
 * live. If no run is active the stream ends immediately with `done`, and the
 * caller falls back to the persisted transcript.
 */
export async function attachRun(sessionId: string, handlers: StreamHandlers): Promise<void> {
  return streamAttachRequest(`/api/chats/${encodeURIComponent(sessionId)}/run`, handlers);
}

/** Ask the backend to cancel a session's active run (persists the partial turn). */
export async function stopRun(sessionId: string): Promise<void> {
  const res = await fetch(`/api/chats/${encodeURIComponent(sessionId)}/stop`, { method: "POST" });
  if (!res.ok) throw new Error(`Request failed with HTTP ${res.status}`);
}

/** Every chat session across all agents, newest first (for the run list). */
export async function listAllChats(): Promise<ChatSession[]> {
  const res = await fetch("/api/chats");
  const data = await jsonOrThrow<{ sessions: ChatSession[] }>(res);
  return data.sessions;
}

/** One sub-agent spawn of an orchestrator session (shared with the trace model). */
export type { SpawnEvent };

/**
 * The sub-agents an orchestrator session has spawned, oldest first. Reads the
 * agent's spawn log (real timestamps); older sessions fall back to the
 * checkpoint, whose entries carry no times.
 */
export async function fetchSpawns(sessionId: string): Promise<SpawnEvent[]> {
  const res = await fetch(`/api/chats/${encodeURIComponent(sessionId)}/spawns`);
  const data = await jsonOrThrow<{ spawns: Array<Record<string, unknown>> }>(res);
  return data.spawns.map(normalizeSpawn);
}

function normalizeSpawn(raw: Record<string, unknown>): SpawnEvent {
  const status = raw.status;
  const validStatus: SpawnEvent["status"] =
    status === "running" || status === "done" || status === "timed_out" || status === "error" ? status : "done";
  const started = raw.started_at ?? raw.startedAt;
  const finished = raw.finished_at ?? raw.finishedAt;
  return {
    id: typeof raw.id === "string" ? raw.id : null,
    role: typeof raw.role === "string" ? raw.role : "sub-agent",
    goal: typeof raw.goal === "string" ? raw.goal : "",
    status: validStatus,
    // the log stores seconds; the checkpoint fallback has no time at all
    startedAt: typeof started === "number" ? started * 1000 : undefined,
    finishedAt: typeof finished === "number" ? finished * 1000 : null,
    result: typeof raw.result === "string" ? raw.result : null,
  };
}

export async function appendChatMessage(
  id: string,
  msg: { role: ChatSessionMessage["role"]; content: string; links?: string[] | null },
): Promise<ChatSessionMessage> {
  const res = await fetch(`/api/chats/${id}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(msg),
  });
  return jsonOrThrow<ChatSessionMessage>(res);
}

export async function updateChat(
  id: string,
  patch: { title?: string; pinned?: boolean; archived?: boolean; model?: string | null },
): Promise<ChatSessionDetail> {
  const res = await fetch(`/api/chats/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  return jsonOrThrow<ChatSessionDetail>(res);
}

export async function deleteChat(id: string): Promise<void> {
  const res = await fetch(`/api/chats/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Request failed with HTTP ${res.status}`);
}

/** Delete many sessions in one request. Throws on failure so the caller can roll
 *  back optimistic removal; resolves with the ids actually removed. */
export async function deleteChats(ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  const res = await fetch("/api/chats", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  });
  const data = await jsonOrThrow<{ deleted: string[]; missing: string[] }>(res);
  return data.deleted;
}

/**
 * Rewind a session so it ends after `seq`, and clear the agent's checkpoint for
 * it — the backend half of a regenerate or edit-and-resend. Pass `content` to
 * rewrite the turn at `seq` (edit); omit it to keep the turn as it is
 * (regenerate). Returns the rewound session.
 */
export async function rewindChat(id: string, seq: number, content?: string): Promise<ChatSessionDetail> {
  const res = await fetch(`/api/chats/${encodeURIComponent(id)}/rewind`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(content === undefined ? { seq } : { seq, content }),
  });
  return jsonOrThrow<ChatSessionDetail>(res);
}

/** One saved checkpoint of a session's agent graph — a step the run took. */
export interface CheckpointStep {
  checkpointId: string;
  step: number | null;
  messageCount: number;
  lastRole: string | null;
  preview: string;
}

/** A session's saved agent checkpoints, newest first (the rewind picker's source). */
export async function fetchHistory(id: string, limit = 50): Promise<CheckpointStep[]> {
  const res = await fetch(`/api/chats/${encodeURIComponent(id)}/history?limit=${limit}`);
  const data = await jsonOrThrow<{ steps: CheckpointStep[] }>(res);
  return data.steps;
}

/**
 * Fork the session's agent state back to a past checkpoint — the checkpoint-level
 * rewind. Unlike `rewindChat` (which drops the transcript tail), this moves the
 * graph itself to the chosen step, so the next run continues from there.
 */
export async function rewindCheckpoint(id: string, checkpointId: string): Promise<{ ok: boolean }> {
  const res = await fetch(`/api/chats/${encodeURIComponent(id)}/checkpoint`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ checkpointId }),
  });
  return jsonOrThrow<{ ok: boolean }>(res);
}

export function describeLlmError(err: unknown): string {
  if (err instanceof LlmError) {
    switch (err.kind) {
      case "timeout":
        return `The request timed out on attempt ${err.attempts} — retrying is automatic.`;
      case "exhausted":
        return `Timed out ${err.attempts} times in a row. The model endpoint is not answering; try again later or check the connection settings.`;
      case "http":
        return err.status ? `The API answered HTTP ${err.status}.` : err.message;
      case "network":
        return "Network error reaching the endpoint.";
      case "aborted":
        return "Request cancelled.";
    }
  }
  return String(err);
}
