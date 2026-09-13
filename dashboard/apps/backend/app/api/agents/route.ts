import { NextRequest } from "next/server";
import { createAgent, listAgents, type AgentInput } from "@/lib/db/agents";
import { requireOperator } from "@/lib/server/auth";
import { saveAgentConfig } from "@/lib/server/agent-config";

export const dynamic = "force-dynamic";

/** The runtime agent roster (the shape the swarm grid renders). */
export async function GET() {
  const gate = await requireOperator();
  if (gate instanceof Response) return gate;
  return Response.json({ agents: listAgents() });
}

/** Coerce an untrusted payload into an AgentInput (core fields only). */
function readCore(body: Record<string, unknown>): AgentInput {
  const s = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  return {
    name: typeof body.name === "string" ? body.name : "",
    role: s(body.role),
    status: typeof body.status === "string" ? (body.status as AgentInput["status"]) : undefined,
    currentNode: body.currentNode === null || typeof body.currentNode === "string" ? (body.currentNode as string | null) : undefined,
    task: s(body.task),
    focus: s(body.focus),
    model: body.model === null || typeof body.model === "string" ? (body.model as string | null) : undefined,
    apiUrl: body.apiUrl === null || typeof body.apiUrl === "string" ? (body.apiUrl as string | null) : undefined,
    apiKey: body.apiKey === null || typeof body.apiKey === "string" ? (body.apiKey as string | null) : undefined,
  };
}

export async function POST(request: NextRequest) {
  const gate = await requireOperator();
  if (gate instanceof Response) return gate;
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Malformed JSON body" }, { status: 400 });
  }
  const core = readCore(body);
  if (!core.name.trim()) return Response.json({ error: "name is required" }, { status: 400 });

  const row = createAgent(core);

  // Capabilities arrive in the same payload; persist them against the new id.
  const strArray = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;
  const patch: Parameters<typeof saveAgentConfig>[1] = {};
  if (body.tools === null) patch.tools = null;
  else if (Array.isArray(body.tools)) patch.tools = strArray(body.tools);
  const skills = strArray(body.skills);
  if (skills) patch.skills = skills;
  const mcps = strArray(body.mcpServers);
  if (mcps) patch.mcpServers = mcps;
  if (typeof body.terminalMode === "string") patch.terminalMode = body.terminalMode as never;
  if (Object.keys(patch).length) saveAgentConfig(row.id, patch);

  return Response.json({ id: row.id }, { status: 201 });
}
