import { NextRequest } from "next/server";
import { deleteSession, getSession, updateSession } from "@/lib/db/sessions";
import { requireOperator } from "@/lib/server/auth";

export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireOperator();
  if (gate instanceof Response) return gate;
  const { id } = await params;
  const session = getSession(id);
  if (!session) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json(session);
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireOperator();
  if (gate instanceof Response) return gate;
  const { id } = await params;
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Malformed JSON body" }, { status: 400 });
  }
  const session = updateSession(id, {
    title: typeof body.title === "string" ? body.title : undefined,
    model: body.model === null || typeof body.model === "string" ? (body.model as string | null) : undefined,
    pinned: typeof body.pinned === "boolean" ? body.pinned : undefined,
    archived: typeof body.archived === "boolean" ? body.archived : undefined,
  });
  if (!session) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json(session);
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireOperator();
  if (gate instanceof Response) return gate;
  const { id } = await params;
  const ok = deleteSession(id);
  if (!ok) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ ok: true });
}
