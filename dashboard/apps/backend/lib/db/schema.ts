import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

/**
 * Persistence for agent chat. A `session` is one conversation with one agent;
 * its turns live in `messages`. Everything the UI shows about history reads
 * from here — nothing is hardcoded.
 */
export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    /** which swarm agent this conversation belongs to ("" = unassigned) */
    agentId: text("agent_id").notNull().default(""),
    title: text("title").notNull().default("New chat"),
    /** per-session model override; null = server default / auto-detect */
    model: text("model"),
    /** per-session tool-execution policy; null = inherit the agent's default */
    permissionMode: text("permission_mode", { enum: ["ask", "bypass"] }),
    pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
    archived: integer("archived", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("sessions_updated_idx").on(t.updatedAt), index("sessions_agent_idx").on(t.agentId)],
);

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    /** monotonic order within a session */
    seq: integer("seq").notNull(),
    role: text("role", { enum: ["system", "user", "assistant"] }).notNull(),
    content: text("content").notNull().default(""),
    /** JSON array of graph-node titles cited via [[wikilinks]] */
    links: text("links"),
    /** JSON array of the turn's recorded SSE envelopes, for trace replay */
    events: text("events"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("messages_session_idx").on(t.sessionId, t.seq)],
);

export type SessionRow = typeof sessions.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;

/** A swarm agent — the roster is data, created and edited from the UI. */
export const agents = sqliteTable(
  "agents",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    role: text("role").notNull().default(""),
    status: text("status", { enum: ["working", "analysing", "idle", "pending"] }).notNull().default("idle"),
    /** graph node this agent is currently on, if any */
    currentNode: text("current_node"),
    task: text("task").notNull().default(""),
    focus: text("focus").notNull().default(""),
    /** per-agent model override (empty = server default / auto) */
    model: text("model"),
    /** per-agent provider endpoint; when set with a key, overrides the server env */
    apiUrl: text("api_url"),
    /** per-agent API key — stored server-side only, never returned to the client */
    apiKey: text("api_key"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("agents_updated_idx").on(t.updatedAt)],
);

export type AgentRow = typeof agents.$inferSelect;

/** Per-agent runtime configuration: which tools, skills, MCP servers it uses. */
export const agentConfigs = sqliteTable("agent_configs", {
  /** swarm agent id, e.g. "kai" */
  agentId: text("agent_id").primaryKey(),
  /** JSON string[] of builtin tool names; null = server defaults */
  tools: text("tools"),
  /** JSON string[] of skill ids applied to this agent */
  skills: text("skills"),
  /** JSON string[] of MCP server ids this agent may call */
  mcpServers: text("mcp_servers"),
  /** terminal access: "off" (default) | "sandbox" | "unsandboxed" */
  terminalMode: text("terminal_mode", { enum: ["off", "sandbox", "unsandboxed"] }).notNull().default("off"),
  /** default tool-execution policy for this agent's sessions: "ask" | "bypass" */
  permissionMode: text("permission_mode", { enum: ["ask", "bypass"] }).notNull().default("ask"),
  updatedAt: integer("updated_at").notNull(),
});

/** Registered MCP servers the server can connect to over streamable HTTP. */
export const mcpServers = sqliteTable("mcp_servers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  url: text("url").notNull(),
  /** stored server-side only; never returned to the client */
  apiKey: text("api_key"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at").notNull(),
});

/** Reusable instruction packs (SKILL.md-style) injected into agent prompts. */
export const skills = sqliteTable("skills", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  content: text("content").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export type AgentConfigRow = typeof agentConfigs.$inferSelect;
export type McpServerRow = typeof mcpServers.$inferSelect;
export type SkillRow = typeof skills.$inferSelect;

/**
 * Operator accounts — the humans who sign in to the control plane. Open
 * signup, so email is unique (stored lowercase) and the scrypt password hash
 * is never returned to the client.
 */
export const operators = sqliteTable("operators", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name").notNull().default(""),
  role: text("role").notNull().default(""),
  passwordHash: text("password_hash").notNull(),
  createdAt: integer("created_at").notNull(),
});

export type OperatorRow = typeof operators.$inferSelect;

/**
 * DB-backed, revocable login sessions. The primary key IS the bearer token
 * (opaque, random) sent in the `agent-session` cookie. Distinct from the chat
 * `sessions` table above.
 */
export const authSessions = sqliteTable(
  "auth_sessions",
  {
    id: text("id").primaryKey(),
    operatorId: text("operator_id")
      .notNull()
      .references(() => operators.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (t) => [index("auth_sessions_operator_idx").on(t.operatorId)],
);

export type AuthSessionRow = typeof authSessions.$inferSelect;
