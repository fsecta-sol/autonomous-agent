import { NextRequest } from "next/server";
import { requireOperator } from "@/lib/server/auth";

export const dynamic = "force-dynamic";

const AGENT_URL = (process.env.AGENT_URL || "http://127.0.0.1:8012").replace(/\/+$/, "");

/**
 * The Research Evaluator's structured output for one run — one decision-support
 * record per iteration (dimensions, evidence grades, contradictions, signals,
 * recommendation). `?limit=` caps how many to return; `?lean=true` collapses the
 * heavy arrays to lengths so a large run can be filtered/charted in one response.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireOperator();
  if (gate instanceof Response) return gate;
  const { id } = await params;
  const limit = request.nextUrl.searchParams.get("limit") || "500";
  const lean = request.nextUrl.searchParams.get("lean") === "true" ? "true" : "false";
  try {
    const res = await fetch(
      `${AGENT_URL}/research/runs/${encodeURIComponent(id)}/evaluations?limit=${encodeURIComponent(limit)}&lean=${lean}`,
      { cache: "no-store" },
    );
    if (!res.ok) return Response.json({ error: `Agent service HTTP ${res.status}` }, { status: 502 });
    return Response.json(await res.json());
  } catch (err) {
    return Response.json({ error: "Agent service unavailable", detail: String(err) }, { status: 502 });
  }
}
