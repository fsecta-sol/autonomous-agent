import { NextRequest } from "next/server";
import { requireOperator } from "@/lib/server/auth";
import { getRun } from "@/lib/server/runs";

export const dynamic = "force-dynamic";

/** The agent service that owns the run checkpoints. */
const AGENT_URL = (process.env.AGENT_URL || "http://127.0.0.1:8012").replace(/\/+$/, "");

/**
 * Whether a session's run is paused awaiting tool approval. Proxies the agent's
 * `/state/{thread_id}` (the thread id IS the session id) so the UI can re-surface
 * an approval prompt after a reload. A missing session or an unreachable agent
 * both read as "not paused" — this is a hint, not a gate.
 *
 * The local run registry is checked FIRST: if this process holds the run and it
 * is NOT paused (it is running, or a resume is in flight), the answer is "not
 * paused" regardless of what the agent's last checkpoint still says. That closes
 * the window where a reload during an auto-resume would re-raise a card whose
 * request the mode switch already cleared. With no local run (e.g. after a
 * restart) the agent's checkpoint remains the fallback.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireOperator();
  if (gate instanceof Response) return gate;
  const { id } = await params;

  const run = getRun(id);
  if (run && !run.done && !run.paused) {
    return Response.json({ paused: false, interrupt: null });
  }

  try {
    const res = await fetch(`${AGENT_URL}/state/${encodeURIComponent(id)}`, { cache: "no-store" });
    if (!res.ok) return Response.json({ paused: false, interrupt: null });
    return Response.json(await res.json());
  } catch {
    return Response.json({ paused: false, interrupt: null });
  }
}
