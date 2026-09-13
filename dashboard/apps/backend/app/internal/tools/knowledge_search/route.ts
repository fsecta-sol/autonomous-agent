import { requireInternal } from "@/lib/server/internal-auth";
import { knowledgeSearch } from "@/lib/server/internal-tools";

export const dynamic = "force-dynamic";

/**
 * Internal endpoint: runs the `knowledge_search` tool for the agent service.
 * Body `{ args: {...} }`; response `{ result: "<json string>" }`.
 */
export async function POST(request: Request) {
  const denied = requireInternal(request);
  if (denied) return denied;
  let body: { args?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "Malformed JSON body" }, { status: 400 });
  }
  const args = body.args && typeof body.args === "object" ? (body.args as Record<string, unknown>) : {};
  return Response.json({ result: knowledgeSearch(args) });
}
