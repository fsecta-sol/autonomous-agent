import { NextRequest } from "next/server";
import { requireOperator } from "@/lib/server/auth";
import { getRun } from "@/lib/server/runs";
import { rewindSession, updateMessageContent } from "@/lib/db/sessions";

export const dynamic = "force-dynamic";

/** The agent service that owns each session's LangGraph checkpoint. */
const AGENT_URL = (process.env.AGENT_URL || "http://127.0.0.1:8012").replace(/\/+$/, "");

/**
 * Rewind a session's transcript to (and including) a turn's `seq`, then clear
 * the agent's durable checkpoint for that thread — the two halves of a
 * regenerate / edit-and-resend. The client calls this right before re-running:
 * the transcript tail is dropped so the model re-seeds from exactly what
 * remains, and the checkpoint is dropped so the graph does not keep appending
 * to the discarded state.
 *
 * Body: { seq: number, content?: string }. When `content` is present the turn
 * at `seq` is rewritten first (edit-and-resend); otherwise the turn is kept as
 * is (regenerate). A live run blocks this with 409 — stop it first.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireOperator();
  if (gate instanceof Response) return gate;
  const { id } = await params;

  let body: { seq?: unknown; content?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "Malformed JSON body" }, { status: 400 });
  }
  if (typeof body.seq !== "number" || !Number.isFinite(body.seq)) {
    return Response.json({ error: "seq must be a number" }, { status: 400 });
  }
  const seq = Math.trunc(body.seq);

  // A run in flight owns the transcript; rewinding under it would corrupt state.
  const run = getRun(id);
  if (run && !run.done) {
    return Response.json({ error: "Stop the active run before rewinding" }, { status: 409 });
  }

  if (typeof body.content === "string") updateMessageContent(id, seq, body.content);

  const session = rewindSession(id, seq);
  if (!session) return Response.json({ error: "Not found" }, { status: 404 });

  // Best-effort: a fresh thread and an unreachable agent are both fine — the
  // next run seeds from the (already rewound) transcript either way.
  try {
    await fetch(`${AGENT_URL}/thread/${encodeURIComponent(id)}`, { method: "DELETE" });
  } catch {
    /* the checkpoint clears lazily if the agent is down */
  }

  return Response.json(session);
}
