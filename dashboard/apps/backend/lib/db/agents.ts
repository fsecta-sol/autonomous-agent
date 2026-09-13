import { desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getDb } from "./index";
import { agents, type AgentRow } from "./schema";
import type { Agent, AgentHealth, AgentStatus } from "@dashboard/shared";

/** Neutral health for a roster agent that has no runtime telemetry yet. */
function emptyHealth(): AgentHealth {
  return {
    heartbeat: "—",
    beatOk: true,
    uptime: "—",
    queue: "0 queued",
    errRate: "0%",
    errWarn: false,
    throughput: "—",
    meters: [],
    beats: [],
    incidents: [],
  };
}

function toAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    status: row.status,
    currentNode: row.currentNode,
    task: row.task,
    progress: 0,
    count: "0 tasks",
    focus: row.focus,
    seed: [],
    history: [],
    health: emptyHealth(),
  };
}

/** The client-safe view: identity + connection flags + capabilities. No apiKey. */
export interface AgentDetail {
  id: string;
  name: string;
  role: string;
  status: AgentStatus;
  currentNode: string;
  task: string;
  focus: string;
  model: string;
  apiUrl: string;
  hasKey: boolean;
  tools: string[] | null;
  skills: string[];
  mcpServers: string[];
  terminalMode: string;
  createdAt: number;
  updatedAt: number;
}

export interface AgentInput {
  name: string;
  role?: string;
  status?: AgentStatus;
  currentNode?: string | null;
  task?: string;
  focus?: string;
  model?: string | null;
  apiUrl?: string | null;
  /** when provided, replaces the stored key; "" clears it; undefined leaves it */
  apiKey?: string | null;
}

const STATUSES = new Set<AgentStatus>(["working", "analysing", "idle", "pending"]);

/** The runtime `Agent` list for the UI (defaults filled for non-persisted fields). */
export function listAgents(): Agent[] {
  return getDb().select().from(agents).orderBy(desc(agents.updatedAt)).all().map(toAgent);
}

function rowDetail(row: AgentRow): AgentDetail {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    status: row.status,
    currentNode: row.currentNode ?? "",
    task: row.task,
    focus: row.focus,
    model: row.model ?? "",
    apiUrl: row.apiUrl ?? "",
    hasKey: !!row.apiKey,
    tools: null, // filled by the caller from agent_configs when needed
    skills: [],
    mcpServers: [],
    terminalMode: "off",
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function getAgentRow(id: string): AgentRow | null {
  return getDb().select().from(agents).where(eq(agents.id, id)).get() ?? null;
}

/** The raw DB agent mapped to the client-safe shape (config merged by the route). */
export function getAgentDetail(id: string): AgentDetail | null {
  const row = getAgentRow(id);
  return row ? rowDetail(row) : null;
}

/** Just the connection bits the chat route needs (never sent to the client). */
export interface AgentConnectionInfo {
  exists: boolean;
  apiUrl: string;
  apiKey: string;
  model: string;
}
export function getAgentConnection(id: string): AgentConnectionInfo {
  const row = getAgentRow(id);
  return {
    exists: !!row,
    apiUrl: row?.apiUrl ?? "",
    apiKey: row?.apiKey ?? "",
    model: row?.model ?? "",
  };
}

export function createAgent(input: AgentInput): AgentRow {
  const db = getDb();
  const id = randomUUID();
  const t = Date.now();
  const status: AgentStatus = input.status && STATUSES.has(input.status) ? input.status : "idle";
  db.insert(agents)
    .values({
      id,
      name: input.name.trim() || "Untitled agent",
      role: input.role?.trim() ?? "",
      status,
      currentNode: input.currentNode ?? null,
      task: input.task?.trim() ?? "",
      focus: input.focus?.trim() ?? "",
      model: input.model?.trim() || null,
      apiUrl: input.apiUrl?.trim() || null,
      apiKey: input.apiKey?.trim() || null,
      createdAt: t,
      updatedAt: t,
    })
    .run();
  return getAgentRow(id)!;
}

export function updateAgent(id: string, patch: AgentInput): AgentRow | null {
  const db = getDb();
  const row = getAgentRow(id);
  if (!row) return null;
  const values: Partial<AgentRow> = { updatedAt: Date.now() };
  if (patch.name !== undefined) values.name = patch.name.trim() || row.name;
  if (patch.role !== undefined) values.role = patch.role.trim();
  if (patch.status !== undefined && STATUSES.has(patch.status)) values.status = patch.status;
  if (patch.currentNode !== undefined) values.currentNode = patch.currentNode || null;
  if (patch.task !== undefined) values.task = patch.task.trim();
  if (patch.focus !== undefined) values.focus = patch.focus.trim();
  if (patch.model !== undefined) values.model = patch.model?.trim() || null;
  if (patch.apiUrl !== undefined) values.apiUrl = patch.apiUrl?.trim() || null;
  // apiKey: undefined leaves it; null or "" clears it; a value replaces it
  if (patch.apiKey !== undefined) values.apiKey = patch.apiKey?.trim() || null;
  db.update(agents).set(values).where(eq(agents.id, id)).run();
  return getAgentRow(id);
}

export function deleteAgent(id: string): boolean {
  return getDb().delete(agents).where(eq(agents.id, id)).run().changes > 0;
}

export { toAgent as agentRowToAgent, rowDetail as agentRowToDetail };
