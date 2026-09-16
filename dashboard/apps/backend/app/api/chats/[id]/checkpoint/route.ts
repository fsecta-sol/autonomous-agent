import { NextRequest } from "next/server";
import { requireOperator } from "@/lib/server/auth";
import { getRun } from "@/lib/server/runs";

export const dynamic = "force-dynamic";

/** The agent service that owns each session's LangGraph checkpoints. */
const AGENT_URL = (process.env.AGENT_URL || "http://127.0.0.1:8012").replace(/\/+$/, "");

/**
 * Fork a session's agent state back to a past checkpoint — checkpoint-level time
 * travel (distinct from `/rewind`, which drops the transcript tail). The agent
 * graph's head becomes that checkpoint, so the next `/run` continues from the
 * step the operator picked. Body: { checkpointId }.
 *
 * A run in flight owns the graph state; forking under it would corrupt it, so a
 * live run blocks this with 409.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireOperator();
  if (gate instanceof Response) return gate;
  const { id } = await params;

  let body: { checkpointId?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "Malformed JSON body" }, { status: 400 });
  }
  if (typeof body.checkpointId !== "string" || !body.checkpointId) {
    return Response.json({ error: "checkpointId is required" }, { status: 400 });
  }

  const run = getRun(id);
  if (run && !run.done) {
    return Response.json({ error: "Stop the active run before rewinding" }, { status: 409 });
  }

  try {
    const res = await fetch(`${AGENT_URL}/rewind/${encodeURIComponent(id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ checkpointId: body.checkpointId }),
    });
    if (!res.ok) return Response.json({ error: `Agent service HTTP ${res.status}` }, { status: 502 });
    return Response.json(await res.json());
  } catch (err) {
    return Response.json({ error: "Agent service unavailable", detail: String(err) }, { status: 502 });
  }
}
