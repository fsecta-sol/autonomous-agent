import { NextRequest } from "next/server";
import { requireOperator } from "@/lib/server/auth";

export const dynamic = "force-dynamic";

/** The agent service that owns the run checkpoints. */
const AGENT_URL = (process.env.AGENT_URL || "http://127.0.0.1:8012").replace(/\/+$/, "");

/**
 * Whether a session's run is paused awaiting tool approval. Proxies the agent's
 * `/state/{thread_id}` (the thread id IS the session id) so the UI can re-surface
 * an approval prompt after a reload. A missing session or an unreachable agent
 * both read as "not paused" — this is a hint, not a gate.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireOperator();
  if (gate instanceof Response) return gate;
  const { id } = await params;
  try {
    const res = await fetch(`${AGENT_URL}/state/${encodeURIComponent(id)}`, { cache: "no-store" });
    if (!res.ok) return Response.json({ paused: false, interrupt: null });
    return Response.json(await res.json());
  } catch {
    return Response.json({ paused: false, interrupt: null });
  }
}
