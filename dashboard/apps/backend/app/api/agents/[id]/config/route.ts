import { NextRequest } from "next/server";
import { requireOperator } from "@/lib/server/auth";
import { getAgentConfig, saveAgentConfig, type TerminalMode } from "@/lib/server/agent-config";

const TERMINAL_MODES = new Set<TerminalMode>(["off", "sandbox", "unsandboxed"]);

export const dynamic = "force-dynamic";

/** An agent's runtime configuration: builtin tools, skills, MCP servers. */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireOperator();
  if (gate instanceof Response) return gate;
  const { id } = await params;
  return Response.json(getAgentConfig(id));
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireOperator();
  if (gate instanceof Response) return gate;
  const { id } = await params;
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Malformed JSON body" }, { status: 400 });
  }

  const strArray = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;

  const patch: Parameters<typeof saveAgentConfig>[1] = {};
  // tools: null clears the override (back to server defaults); a list sets it
  if (body.tools === null) patch.tools = null;
  else if (Array.isArray(body.tools)) patch.tools = strArray(body.tools);
  const skills = strArray(body.skills);
  if (skills) patch.skills = skills;
  const mcps = strArray(body.mcpServers);
  if (mcps) patch.mcpServers = mcps;
  if (typeof body.terminalMode === "string" && TERMINAL_MODES.has(body.terminalMode as TerminalMode)) {
    patch.terminalMode = body.terminalMode as TerminalMode;
  }

  return Response.json(saveAgentConfig(id, patch));
}
