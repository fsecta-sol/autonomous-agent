import { NextRequest } from "next/server";
import { createSession, listSessions } from "@/lib/db/sessions";
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
