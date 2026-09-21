import { NextRequest } from "next/server";
import { requireOperator } from "@/lib/server/auth";
import { buildResearchRunConfig } from "@/lib/server/research";

export const dynamic = "force-dynamic";

const AGENT_URL = (process.env.AGENT_URL || "http://127.0.0.1:8012").replace(/\/+$/, "");

/**
 * Research runs collection.
 *   GET  — list runs (newest first), optionally `?status=`.
 *   POST — create a run. The backend resolves the executor config (the agent's
 *          LLM creds + tools, or the server env) exactly as the chat route does,
 *          then hands the run to the agent service, which owns the loop.
 */
export async function GET(request: NextRequest) {
  const gate = await requireOperator();
  if (gate instanceof Response) return gate;
  const status = request.nextUrl.searchParams.get("status") || "";
  const limit = request.nextUrl.searchParams.get("limit") || "50";
  const qs = new URLSearchParams();
  if (status) qs.set("status", status);
  qs.set("limit", limit);
  try {
    const res = await fetch(`${AGENT_URL}/research/runs?${qs.toString()}`, { cache: "no-store" });
    if (!res.ok) return Response.json({ error: `Agent service HTTP ${res.status}` }, { status: 502 });
    return Response.json(await res.json());
  } catch (err) {
    return Response.json({ error: "Agent service unavailable", detail: String(err) }, { status: 502 });
  }
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
  const objective = typeof body.objective === "string" ? body.objective.trim() : "";
  if (!objective) return Response.json({ error: "objective is required" }, { status: 400 });

  const agentId = typeof body.agentId === "string" ? body.agentId : "";
  const config = await buildResearchRunConfig(agentId);

  const payload = {
    objective,
    success_criteria: Array.isArray(body.successCriteria) ? body.successCriteria : [],
    domain: typeof body.domain === "string" ? body.domain : "",
    budget: body.budget && typeof body.budget === "object" ? body.budget : undefined,
    metadata: body.metadata && typeof body.metadata === "object" ? body.metadata : undefined,
    agent_id: agentId,
    config, // null when no LLM is configured — the run starts but cannot execute
    research_config: body.researchConfig && typeof body.researchConfig === "object" ? body.researchConfig : undefined,
    autostart: body.autostart !== false,
  };

  try {
    const res = await fetch(`${AGENT_URL}/research/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    return Response.json(data, { status: res.status });
  } catch (err) {
    return Response.json({ error: "Agent service unavailable", detail: String(err) }, { status: 502 });
  }
}
