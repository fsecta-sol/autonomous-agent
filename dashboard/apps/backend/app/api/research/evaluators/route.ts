import { requireOperator } from "@/lib/server/auth";

export const dynamic = "force-dynamic";

const AGENT_URL = (process.env.AGENT_URL || "http://127.0.0.1:8012").replace(/\/+$/, "");

/**
 * The Research Evaluator's registers: dimension names, evaluator/recommender
 * plugins, and the status + evidence vocabulary. Served so the client renders
 * the evaluator's taxonomy without hardcoding it.
 */
export async function GET() {
  const gate = await requireOperator();
  if (gate instanceof Response) return gate;
  try {
    const res = await fetch(`${AGENT_URL}/research/evaluators`, { cache: "no-store" });
    if (!res.ok) return Response.json({ error: `Agent service HTTP ${res.status}` }, { status: 502 });
    return Response.json(await res.json());
  } catch (err) {
    return Response.json({ error: "Agent service unavailable", detail: String(err) }, { status: 502 });
  }
}
