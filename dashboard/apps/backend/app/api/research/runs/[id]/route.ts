import { NextRequest } from "next/server";
import { requireOperator } from "@/lib/server/auth";

export const dynamic = "force-dynamic";

const AGENT_URL = (process.env.AGENT_URL || "http://127.0.0.1:8012").replace(/\/+$/, "");

/**
 * One research run's full state (run + iterations + candidates + branches).
 * `?iterations_limit=` bounds the iteration list so a large run is not silently
 * truncated at the default cap.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireOperator();
  if (gate instanceof Response) return gate;
  const { id } = await params;
  const iterationsLimit = request.nextUrl.searchParams.get("iterations_limit");
  const qs = iterationsLimit ? `?iterations_limit=${encodeURIComponent(iterationsLimit)}` : "";
  try {
    const res = await fetch(`${AGENT_URL}/research/runs/${encodeURIComponent(id)}${qs}`, { cache: "no-store" });
    if (!res.ok) return Response.json({ error: `Agent service HTTP ${res.status}` }, { status: 502 });
    return Response.json(await res.json());
  } catch (err) {
    return Response.json({ error: "Agent service unavailable", detail: String(err) }, { status: 502 });
  }
}
