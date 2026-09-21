import { NextRequest } from "next/server";
import { requireOperator } from "@/lib/server/auth";

export const dynamic = "force-dynamic";

const AGENT_URL = (process.env.AGENT_URL || "http://127.0.0.1:8012").replace(/\/+$/, "");

/**
 * The lifecycle verbs allowed per scheduler entity. Validated here so an unknown
 * kind/action 404s locally rather than being forwarded.
 */
const ACTIONS: Record<string, string[]> = {
  schedules: ["pause", "resume", "cancel"],
  jobs: ["pause", "resume", "cancel", "trigger", "replay"],
};

/** POST /api/scheduler/{schedules|jobs}/{id}/{action} — proxy a control verb. */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ kind: string; id: string; action: string }> }) {
  const gate = await requireOperator();
  if (gate instanceof Response) return gate;
  const { kind, id, action } = await params;
  if (!ACTIONS[kind] || !ACTIONS[kind].includes(action)) {
    return Response.json({ error: `Unknown action: ${kind}/${action}` }, { status: 404 });
  }
  try {
    const res = await fetch(`${AGENT_URL}/scheduler/${kind}/${encodeURIComponent(id)}/${action}`, { method: "POST" });
    if (!res.ok) return Response.json({ error: `Agent service HTTP ${res.status}` }, { status: 502 });
    return Response.json(await res.json());
  } catch (err) {
    return Response.json({ error: "Agent service unavailable", detail: String(err) }, { status: 502 });
  }
}
