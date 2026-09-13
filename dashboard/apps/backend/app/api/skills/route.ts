import { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { skills } from "@/lib/db/schema";
import { requireOperator } from "@/lib/server/auth";

export const dynamic = "force-dynamic";

const MAX_CONTENT_CHARS = 100_000;

export async function GET() {
  const gate = await requireOperator();
  if (gate instanceof Response) return gate;
  const rows = getDb().select().from(skills).all();
  return Response.json({ skills: rows });
}

export async function POST(request: NextRequest) {
  const gate = await requireOperator();
  if (gate instanceof Response) return gate;
  let body: { name?: unknown; description?: unknown; content?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "Malformed JSON body" }, { status: 400 });
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const content = typeof body.content === "string" ? body.content : "";
  if (!name || !content.trim()) return Response.json({ error: "name and content are required" }, { status: 400 });
  if (content.length > MAX_CONTENT_CHARS) {
    return Response.json({ error: `content exceeds ${MAX_CONTENT_CHARS} characters` }, { status: 413 });
  }
  const now = Date.now();
  const id = randomUUID();
  getDb()
    .insert(skills)
    .values({
      id,
      name,
      description: typeof body.description === "string" ? body.description.trim() : "",
      content,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return Response.json({ id, name, description: body.description ?? "", content, enabled: true, createdAt: now, updatedAt: now }, { status: 201 });
}

export async function PATCH(request: NextRequest) {
  const gate = await requireOperator();
  if (gate instanceof Response) return gate;
  let body: { id?: unknown; name?: unknown; description?: unknown; content?: unknown; enabled?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "Malformed JSON body" }, { status: 400 });
  }
  if (typeof body.id !== "string") return Response.json({ error: "id is required" }, { status: 400 });
  const db = getDb();
  const row = db.select().from(skills).where(eq(skills.id, body.id)).get();
  if (!row) return Response.json({ error: "Not found" }, { status: 404 });

  const values: Partial<typeof skills.$inferInsert> = { updatedAt: Date.now() };
  if (typeof body.name === "string" && body.name.trim()) values.name = body.name.trim();
  if (typeof body.description === "string") values.description = body.description.trim();
  if (typeof body.content === "string" && body.content.trim()) {
    if (body.content.length > MAX_CONTENT_CHARS) {
      return Response.json({ error: `content exceeds ${MAX_CONTENT_CHARS} characters` }, { status: 413 });
    }
    values.content = body.content;
  }
  if (typeof body.enabled === "boolean") values.enabled = body.enabled;
  db.update(skills).set(values).where(eq(skills.id, body.id)).run();
  return Response.json({ ok: true });
}

export async function DELETE(request: NextRequest) {
  const gate = await requireOperator();
  if (gate instanceof Response) return gate;
  const id = request.nextUrl.searchParams.get("id");
  if (!id) return Response.json({ error: "id is required" }, { status: 400 });
  const res = getDb().delete(skills).where(eq(skills.id, id)).run();
  if (res.changes === 0) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ ok: true });
}
