import { NextRequest } from "next/server";
import { requireOperator } from "@/lib/server/auth";
import { abortRun } from "@/lib/server/runs";

export const dynamic = "force-dynamic";

/**
 * Cancel a session's active run. Aborting the run's controller cancels the
 * upstream fetch, which (via disconnect) stops the agent's run; the detached
 * pump then persists whatever streamed as the turn's partial reply. `ok` is true
 * when a run was actually cancelled.
 */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireOperator();
  if (gate instanceof Response) return gate;
  const { id } = await params;
  const cancelled = abortRun(id);
  return Response.json({ ok: cancelled });
}
