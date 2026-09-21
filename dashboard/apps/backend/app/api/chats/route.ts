import { NextRequest } from "next/server";
import { createSession, deleteSessions, listSessions } from "@/lib/db/sessions";
import { requireOperator } from "@/lib/server/auth";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const gate = await requireOperator();
  if (gate instanceof Response) return gate;
  const p = request.nextUrl.searchParams;
  const sessions = listSessions({
    agentId: p.get("agentId") || undefined,
    search: p.get("q") || undefined,
    includeArchived: p.get("archived") === "1",
    limit: p.get("limit") ? Number(p.get("limit")) : undefined,
  });
  return Response.json({ sessions });
}

export async function POST(request: NextRequest) {
  const gate = await requireOperator();
  if (gate instanceof Response) return gate;
  let body: { agentId?: unknown; title?: unknown; model?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    /* empty body is fine — create a blank session */
  }
  const session = createSession({
    agentId: typeof body.agentId === "string" ? body.agentId : "",
    title: typeof body.title === "string" ? body.title : undefined,
    model: typeof body.model === "string" && body.model.trim() ? body.model.trim() : null,
  });
  return Response.json(session, { status: 201 });
}

/**
 * Bulk-delete sessions: `{ ids: [...] }`. One statement, not N requests, so a
 * large selection deletes atomically and never hammers the DB. Returns the ids
 * that were actually removed, plus a `missing` list — an id already gone is not
 * an error, so a client can honestly report "deleted N of M" for a partial set.
 */
export async function DELETE(request: NextRequest) {
  const gate = await requireOperator();
  if (gate instanceof Response) return gate;
  let body: { ids?: unknown } = {};
  try {
    body = (await request.json()) as { ids?: unknown };
  } catch {
    return Response.json({ error: "Malformed JSON body" }, { status: 400 });
  }
  const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
  if (!ids.length) return Response.json({ error: "ids is required" }, { status: 400 });
  const deleted = deleteSessions(ids);
  const missing = [...new Set(ids)].filter((id) => !deleted.includes(id));
  return Response.json({ deleted, missing });
}
