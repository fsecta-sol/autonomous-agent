import { NextRequest } from "next/server";
import { requireOperator } from "@/lib/server/auth";

export const dynamic = "force-dynamic";

/** The agent service that owns each session's LangGraph checkpoints. */
const AGENT_URL = (process.env.AGENT_URL || "http://127.0.0.1:8012").replace(/\/+$/, "");

/**
 * A session's saved checkpoints, newest first — one entry per step the run graph
 * took (see the agent's `GET /history/{thread_id}`). Proxies the agent so the
 * workspace can render a step timeline and a rewind picker. An unreachable agent
 * reads as an empty history; this is a display hint, not a gate.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireOperator();
  if (gate instanceof Response) return gate;
  const { id } = await params;

  const limit = request.nextUrl.searchParams.get("limit") || "50";
  try {
    const res = await fetch(`${AGENT_URL}/history/${encodeURIComponent(id)}?limit=${encodeURIComponent(limit)}`, {
      cache: "no-store",
    });
    if (!res.ok) return Response.json({ steps: [] });
    return Response.json(await res.json());
  } catch {
    return Response.json({ steps: [] });
  }
}
