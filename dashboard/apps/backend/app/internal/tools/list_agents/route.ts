import { requireInternal } from "@/lib/server/internal-auth";
import { listAgentsTool } from "@/lib/server/internal-tools";

export const dynamic = "force-dynamic";

/**
 * Internal endpoint: runs the `list_agents` tool for the agent service.
 * Response `{ result: "<json string>" }`.
 */
export async function POST(request: Request) {
  const denied = requireInternal(request);
  if (denied) return denied;
  return Response.json({ result: listAgentsTool() });
}
