import { NextRequest } from "next/server";
import { requireOperator } from "@/lib/server/auth";
import { endedStream, getRun, runStream } from "@/lib/server/runs";

export const dynamic = "force-dynamic";

/**
 * Attach to a session's in-flight run (SSE). The run is owned by the backend, so
 * a client that reloaded or re-opened the chat can re-attach here: it gets the
 * run replayed from the start (rebuilding the steps already taken) and then
 * follows it live to `done`. With no active run it emits a single `done` and
 * closes, and the caller reads the persisted transcript instead.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireOperator();
  if (gate instanceof Response) return gate;
  const { id } = await params;

  // A paused run is not streaming: the client re-attaches through an approval
  // prompt, so a plane attach just ends (the caller reads the persisted log).
  const run = getRun(id);
  const stream = run && !run.done && !run.paused ? runStream(run) : endedStream();

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
