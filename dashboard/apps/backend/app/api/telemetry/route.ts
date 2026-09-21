import { requireOperator } from "@/lib/server/auth";
import { buildTelemetry } from "@/lib/server/telemetry";

export const dynamic = "force-dynamic";

/**
 * The swarm's runtime telemetry snapshot: per-agent heartbeat, queue, error
 * rate, throughput and latency, plus process uptime — all derived from the run
 * registry and the persisted transcript, never hardcoded. The UI polls this to
 * keep its status surface honest.
 */
export async function GET() {
  const gate = await requireOperator();
  if (gate instanceof Response) return gate;
  return Response.json(buildTelemetry(), { headers: { "Cache-Control": "no-store" } });
}
