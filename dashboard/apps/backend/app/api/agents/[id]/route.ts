import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { agentConfigs, sessions } from "@/lib/db/schema";
import { deleteAgent, getAgentDetail, updateAgent, type AgentInput } from "@/lib/db/agents";
import { requireOperator } from "@/lib/server/auth";
import { getAgentConfig, saveAgentConfig } from "@/lib/server/agent-config";

export const dynamic = "force-dynamic";

/** Full record for the edit form: identity + connection flags + capabilities. */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireOperator();
  if (gate instanceof Response) return gate;
  const { id } = await params;
  const detail = getAgentDetail(id);
  if (!detail) return Response.json({ error: "Not found" }, { status: 404 });
  const cfg = getAgentConfig(id);
  return Response.json({
    ...detail,
    tools: cfg.tools,
    skills: cfg.skills,
    mcpServers: cfg.mcpServers,
    terminalMode: cfg.terminalMode,
  });
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireOperator();
  if (gate instanceof Response) return gate;
  const { id } = await params;
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Malformed JSON body" }, { status: 400 });
  }

  const s = (v: unknown) => (typeof v === "string" ? v : undefined);
  const patch: Partial<AgentInput> = {};
  if (typeof body.name === "string") patch.name = body.name;
  if (body.role !== undefined) patch.role = s(body.role) ?? "";
  if (typeof body.status === "string") patch.status = body.status as AgentInput["status"];
  if (body.currentNode !== undefined) patch.currentNode = typeof body.currentNode === "string" ? body.currentNode : "";
  if (body.task !== undefined) patch.task = s(body.task) ?? "";
  if (body.focus !== undefined) patch.focus = s(body.focus) ?? "";
  if (body.model !== undefined) patch.model = typeof body.model === "string" ? body.model : null;
  if (body.apiUrl !== undefined) patch.apiUrl = typeof body.apiUrl === "string" ? body.apiUrl : null;
  if (body.apiKey !== undefined) patch.apiKey = typeof body.apiKey === "string" ? body.apiKey : null;

  const row = updateAgent(id, patch as AgentInput);
  if (!row) return Response.json({ error: "Not found" }, { status: 404 });

  // capabilities, if included
  const strArray = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;
  const cfgPatch: Parameters<typeof saveAgentConfig>[1] = {};
  if (body.tools === null) cfgPatch.tools = null;
  else if (Array.isArray(body.tools)) cfgPatch.tools = strArray(body.tools);
  const skills = strArray(body.skills);
  if (skills) cfgPatch.skills = skills;
  const mcps = strArray(body.mcpServers);
  if (mcps) cfgPatch.mcpServers = mcps;
  if (typeof body.terminalMode === "string") cfgPatch.terminalMode = body.terminalMode as never;
  if (Object.keys(cfgPatch).length) saveAgentConfig(id, cfgPatch);

  return Response.json({ ok: true });
}

/** Remove an agent and everything that referenced it. */
export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireOperator();
  if (gate instanceof Response) return gate;
  const { id } = await params;
  const db = getDb();
  db.delete(agentConfigs).where(eq(agentConfigs.agentId, id)).run();
  db.delete(sessions).where(eq(sessions.agentId, id)).run(); // messages cascade
  const ok = deleteAgent(id);
  if (!ok) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ ok: true });
}
