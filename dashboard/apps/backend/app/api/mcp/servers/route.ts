import { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { mcpServers } from "@/lib/db/schema";
import { requireOperator } from "@/lib/server/auth";

export const dynamic = "force-dynamic";

/** api_key is write-only: it never leaves the server. */
export async function GET() {
  const gate = await requireOperator();
  if (gate instanceof Response) return gate;
  const rows = getDb().select().from(mcpServers).all();
  return Response.json({
    servers: rows.map((r) => ({ id: r.id, name: r.name, url: r.url, enabled: r.enabled, hasKey: !!r.apiKey })),
  });
}

export async function POST(request: NextRequest) {
  const gate = await requireOperator();
  if (gate instanceof Response) return gate;
  let body: { name?: unknown; url?: unknown; apiKey?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "Malformed JSON body" }, { status: 400 });
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const url = typeof body.url === "string" ? body.url.trim() : "";
  if (!name || !url) return Response.json({ error: "name and url are required" }, { status: 400 });
  try {
    new URL(url);
  } catch {
    return Response.json({ error: "url must be absolute" }, { status: 400 });
  }
  const id = randomUUID();
  getDb()
    .insert(mcpServers)
    .values({
      id,
      name,
      url,
      apiKey: typeof body.apiKey === "string" && body.apiKey.trim() ? body.apiKey.trim() : null,
      createdAt: Date.now(),
    })
    .run();
  return Response.json({ id, name, url, enabled: true, hasKey: !!body.apiKey }, { status: 201 });
}

export async function PATCH(request: NextRequest) {
  const gate = await requireOperator();
  if (gate instanceof Response) return gate;
  let body: { id?: unknown; name?: unknown; url?: unknown; apiKey?: unknown; enabled?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "Malformed JSON body" }, { status: 400 });
  }
  if (typeof body.id !== "string") return Response.json({ error: "id is required" }, { status: 400 });
  const db = getDb();
  const row = db.select().from(mcpServers).where(eq(mcpServers.id, body.id)).get();
  if (!row) return Response.json({ error: "Not found" }, { status: 404 });

  const values: Partial<typeof mcpServers.$inferInsert> = {};
  if (typeof body.name === "string" && body.name.trim()) values.name = body.name.trim();
  if (typeof body.url === "string" && body.url.trim()) {
    try {
      new URL(body.url.trim());
    } catch {
      return Response.json({ error: "url must be absolute" }, { status: 400 });
    }
    values.url = body.url.trim();
  }
  if (typeof body.apiKey === "string") values.apiKey = body.apiKey.trim() ? body.apiKey.trim() : null;
  if (typeof body.enabled === "boolean") values.enabled = body.enabled;
  db.update(mcpServers).set(values).where(eq(mcpServers.id, body.id)).run();
  return Response.json({ ok: true });
}

export async function DELETE(request: NextRequest) {
  const gate = await requireOperator();
  if (gate instanceof Response) return gate;
  const id = request.nextUrl.searchParams.get("id");
  if (!id) return Response.json({ error: "id is required" }, { status: 400 });
  const res = getDb().delete(mcpServers).where(eq(mcpServers.id, id)).run();
  if (res.changes === 0) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ ok: true });
}
