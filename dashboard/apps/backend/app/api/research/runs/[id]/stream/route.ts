import { NextRequest } from "next/server";
import { requireOperator } from "@/lib/server/auth";

export const dynamic = "force-dynamic";

const AGENT_URL = (process.env.AGENT_URL || "http://127.0.0.1:8012").replace(/\/+$/, "");

/**
 * Live SSE of a research run's events. Proxied straight through from the agent
 * service (which replays the durable log, then follows live), so the framing is
 * identical to the chat stream and the existing client reader works unchanged.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireOperator();
  if (gate instanceof Response) return gate;
  const { id } = await params;
  try {
    const res = await fetch(`${AGENT_URL}/research/runs/${encodeURIComponent(id)}/stream`, {
      headers: { Accept: "text/event-stream" },
      signal: request.signal,
    });
    if (!res.ok || !res.body) {
      return Response.json({ error: `Agent service HTTP ${res.status}` }, { status: 502 });
    }
    return new Response(res.body, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (err) {
    return Response.json({ error: "Agent service unavailable", detail: String(err) }, { status: 502 });
  }
}
