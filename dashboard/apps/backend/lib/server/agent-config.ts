import { eq, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { agentConfigs, mcpServers, skills, type AgentConfigRow } from "@/lib/db/schema";
import { selectToolNames } from "./tool-catalog";

/** Terminal access level for an agent. The agent service enforces it. */
export type TerminalMode = "off" | "sandbox" | "unsandboxed";

/** Cap on total characters of skill content injected into one system prompt. */
const SKILL_BUDGET_CHARS = 24_000;

export interface AgentConfig {
  tools: string[] | null;
  skills: string[];
  mcpServers: string[];
  /** terminal access level for this agent */
  terminalMode: TerminalMode;
}

const DEFAULT_CONFIG: AgentConfig = { tools: null, skills: [], mcpServers: [], terminalMode: "off" };

function parseJsonArray(raw: string | null | undefined): string[] | null {
  if (raw === null || raw === undefined) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : null;
  } catch {
    return null;
  }
}

function toConfig(row: AgentConfigRow): AgentConfig {
  return {
    tools: parseJsonArray(row.tools),
    skills: parseJsonArray(row.skills) ?? [],
    mcpServers: parseJsonArray(row.mcpServers) ?? [],
    terminalMode: row.terminalMode ?? "off",
  };
}

export function getAgentConfig(agentId: string): AgentConfig {
  const row = getDb().select().from(agentConfigs).where(eq(agentConfigs.agentId, agentId)).get();
  return row ? toConfig(row) : DEFAULT_CONFIG;
}

export function saveAgentConfig(agentId: string, patch: Partial<AgentConfig>): AgentConfig {
  const db = getDb();
  const existing = db.select().from(agentConfigs).where(eq(agentConfigs.agentId, agentId)).get();
  const merged: AgentConfig = {
    tools: patch.tools !== undefined ? patch.tools : existing ? (parseJsonArray(existing.tools) ?? null) : null,
    skills: patch.skills ?? (existing ? (parseJsonArray(existing.skills) ?? []) : []),
    mcpServers: patch.mcpServers ?? (existing ? (parseJsonArray(existing.mcpServers) ?? []) : []),
    terminalMode: patch.terminalMode ?? (existing ? (existing.terminalMode ?? "off") : "off"),
  };
  const values = {
    agentId,
    tools: merged.tools === null ? null : JSON.stringify(merged.tools),
    skills: JSON.stringify(merged.skills),
    mcpServers: JSON.stringify(merged.mcpServers),
    terminalMode: merged.terminalMode,
    updatedAt: Date.now(),
  };
  if (existing) db.update(agentConfigs).set(values).where(eq(agentConfigs.agentId, agentId)).run();
  else db.insert(agentConfigs).values(values).run();
  return merged;
}

/** An MCP server the agent service should connect to for this run. */
export interface McpServerTarget {
  id: string;
  name: string;
  url: string;
  apiKey: string | null;
}

export interface ResolvedAgentTooling {
  /** builtin tool names, per the agent's config (or defaults when unset) */
  builtins: string[];
  /** enabled MCP servers the agent connects to itself (streamable HTTP) */
  mcp: McpServerTarget[];
  /** instruction packs appended to the system prompt, already joined */
  skillPrompt: string;
  /** human-readable problems (e.g. a disabled skill) */
  warnings: string[];
  /** the agent's terminal access level */
  terminalMode: TerminalMode;
}

/**
 * Everything the agent service needs to run one agent: which builtin tools it
 * may call, which MCP servers to connect to, and the skill text for its prompt.
 * This backend owns the config; the agent stays stateless and receives it here.
 */
export function resolveAgentTooling(agentId: string): ResolvedAgentTooling {
  const config = getAgentConfig(agentId);
  const warnings: string[] = [];

  const builtins = selectToolNames(config.tools ?? undefined);

  // Terminal access is a separate axis from the generic tool list; when the
  // agent's mode is not "off", run_command joins its tool set.
  if (config.terminalMode !== "off" && !builtins.includes("run_command")) {
    builtins.push("run_command");
  }

  const mcp: McpServerTarget[] = [];
  if (config.mcpServers.length) {
    const db = getDb();
    const rows = db
      .select()
      .from(mcpServers)
      .where(inArray(mcpServers.id, config.mcpServers))
      .all()
      .filter((r) => r.enabled);
    for (const row of rows) {
      mcp.push({ id: row.id, name: row.name, url: row.url, apiKey: row.apiKey });
    }
    const enabledIds = new Set(rows.map((r) => r.id));
    for (const id of config.mcpServers) {
      if (!enabledIds.has(id)) warnings.push(`MCP server ${id} is disabled or missing — skipped`);
    }
  }

  let skillPrompt = "";
  if (config.skills.length) {
    const rows = getDb()
      .select()
      .from(skills)
      .where(inArray(skills.id, config.skills))
      .all()
      .filter((r) => r.enabled);
    let budget = SKILL_BUDGET_CHARS;
    const sections: string[] = [];
    for (const row of rows) {
      if (budget <= 0) {
        warnings.push(`Skill "${row.name}" skipped — prompt budget exhausted`);
        continue;
      }
      const body = row.content.length > budget ? row.content.slice(0, budget) : row.content;
      budget -= body.length;
      sections.push(`### Skill: ${row.name}\n${body}`);
    }
    if (sections.length) skillPrompt = sections.join("\n\n");
  }

  return { builtins, mcp, skillPrompt, warnings, terminalMode: config.terminalMode };
}
