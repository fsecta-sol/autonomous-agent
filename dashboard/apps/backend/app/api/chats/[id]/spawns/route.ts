import { NextRequest } from "next/server";
import { requireOperator } from "@/lib/server/auth";

export const dynamic = "force-dynamic";

/** The agent service that owns the run checkpoints (and thus the spawn log). */
const AGENT_URL = (process.env.AGENT_URL || "http://127.0.0.1:8012").replace(/\/+$/, "");

/**
 * The sub-agents an orchestrator session has spawned. Proxies the agent's
 * `/spawns/{thread_id}` (the thread id IS the session id). An unreachable agent
 * reads as "no spawns" — this is a view, not a gate.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireOperator();
  if (gate instanceof Response) return gate;
  const { id } = await params;
  try {
    const res = await fetch(`${AGENT_URL}/spawns/${encodeURIComponent(id)}`, { cache: "no-store" });
    if (!res.ok) return Response.json({ spawns: [] });
    return Response.json(await res.json());
  } catch {
    return Response.json({ spawns: [] });
  }
}
