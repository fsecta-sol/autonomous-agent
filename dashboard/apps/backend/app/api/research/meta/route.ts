import { requireOperator } from "@/lib/server/auth";

export const dynamic = "force-dynamic";

const AGENT_URL = (process.env.AGENT_URL || "http://127.0.0.1:8012").replace(/\/+$/, "");

/**
 * Research Loop metadata for the UI: the registered strategies / prioritizers /
 * stop conditions (the plugin registries) and the status + stage vocabulary, so
 * the client renders the state machine without hardcoding it.
 */
export async function GET() {
  const gate = await requireOperator();
  if (gate instanceof Response) return gate;
  try {
    const [meta, health] = await Promise.all([
      fetch(`${AGENT_URL}/research/strategies`, { cache: "no-store" }),
      fetch(`${AGENT_URL}/research/health`, { cache: "no-store" }),
    ]);
    const metaJson = meta.ok ? await meta.json() : {};
    const healthJson = health.ok ? await health.json() : {};
    return Response.json({ ...metaJson, ...healthJson });
  } catch (err) {
    return Response.json({ error: "Agent service unavailable", detail: String(err) }, { status: 502 });
  }
}
