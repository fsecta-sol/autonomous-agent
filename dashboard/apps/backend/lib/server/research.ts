import {
  readUpstreamConfig,
  resolveEffectiveConnection,
  resolveModel,
  findAgent,
  persona,
} from "@/lib/server/llm-provider";
import { resolveAgentTooling } from "@/lib/server/agent-config";

/**
 * Build the executor config a research run runs under, resolved the same way the
 * chat route resolves a run: the agent's own endpoint+key when set, else the
 * server env; its tool set; and the resolved model. The agent service is
 * stateless, so this config is handed to it per run and never persisted there.
 *
 * Returns `null` when the deployment has no LLM configured — the run still
 * starts, but its executor produces insufficient-evidence results rather than
 * pretending to have researched (an honest degradation).
 */
export interface ResearchRunConfig {
  agentId: string;
  llm: { baseUrl: string; apiKey: string; model: string };
  tools: string[];
  terminalMode: "off" | "sandbox" | "unsandboxed";
  permissionMode: "ask" | "bypass";
  allowUnsandboxed: boolean;
  mcp: unknown[];
  system: string;
  warnings: string[];
}

export async function buildResearchRunConfig(agentId: string): Promise<ResearchRunConfig | null> {
  const envCfg = readUpstreamConfig();
  const cfg = resolveEffectiveConnection(envCfg, agentId);
  if (!cfg.apiKey) return null;

  const tooling = resolveAgentTooling(agentId);
  const agent = findAgent(agentId);

  let model: string;
  try {
    model = (await resolveModel(cfg)).model;
  } catch {
    return null;
  }

  return {
    agentId,
    llm: { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model },
    // The research loop runs each plan as a headless sub-agent; the terminal and
    // delegation tools are excluded agent-side.
    tools: tooling.builtins,
    terminalMode: tooling.terminalMode,
    permissionMode: tooling.permissionMode,
    allowUnsandboxed: process.env.TERMINAL_ALLOW_UNSANDBOXED === "1",
    mcp: tooling.mcp,
    system: agent ? persona(agent) : "You are a research assistant.",
    warnings: tooling.warnings,
  };
}
