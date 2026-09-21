import { NextRequest } from "next/server";
import { requireOperator } from "@/lib/server/auth";

export const dynamic = "force-dynamic";

const AGENT_URL = (process.env.AGENT_URL || "http://127.0.0.1:8012").replace(/\/+$/, "");

/** The lifecycle verbs that proxy straight to the agent service. */
const ACTIONS: Record<string, "POST"> = {
  step: "POST",
  advance: "POST",
  pause: "POST",
  resume: "POST",
  cancel: "POST",
};

/**
 * POST /api/research/runs/{id}/{action} — step | advance | pause | resume | cancel.
 * The action is validated against the allow-list before proxying, so an unknown
 * verb 404s here rather than being forwarded.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; action: string }> }) {
  const gate = await requireOperator();
  if (gate instanceof Response) return gate;
  const { id, action } = await params;
  if (!(action in ACTIONS)) {
    return Response.json({ error: `Unknown action: ${action}` }, { status: 404 });
  }
  const qs = new URLSearchParams();
  const maxSteps = request.nextUrl.searchParams.get("max_steps");
  if (action === "advance" && maxSteps) qs.set("max_steps", maxSteps);
  const q = qs.toString();
  try {
    const res = await fetch(`${AGENT_URL}/research/runs/${encodeURIComponent(id)}/${action}${q ? `?${q}` : ""}`, {
      method: "POST",
    });
    if (!res.ok) return Response.json({ error: `Agent service HTTP ${res.status}` }, { status: 502 });
    return Response.json(await res.json());
  } catch (err) {
    return Response.json({ error: "Agent service unavailable", detail: String(err) }, { status: 502 });
  }
}
