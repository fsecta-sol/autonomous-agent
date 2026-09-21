import { NextRequest } from "next/server";
import { requireOperator } from "@/lib/server/auth";

export const dynamic = "force-dynamic";

const AGENT_URL = (process.env.AGENT_URL || "http://127.0.0.1:8012").replace(/\/+$/, "");

/**
 * The executed result of each iteration of a run: the sub-agent's evidence-first
 * output (observations, evidence, conclusions, uncertainties) plus its observable
 * activity trace (thought / tool_call / tool_result steps).
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireOperator();
  if (gate instanceof Response) return gate;
  const { id } = await params;
  const limit = request.nextUrl.searchParams.get("limit") || "500";
  try {
    const res = await fetch(
      `${AGENT_URL}/research/runs/${encodeURIComponent(id)}/results?limit=${encodeURIComponent(limit)}`,
      { cache: "no-store" },
    );
    if (!res.ok) return Response.json({ error: `Agent service HTTP ${res.status}` }, { status: 502 });
    return Response.json(await res.json());
  } catch (err) {
    return Response.json({ error: "Agent service unavailable", detail: String(err) }, { status: 502 });
  }
}
