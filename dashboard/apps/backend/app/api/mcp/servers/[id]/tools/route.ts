import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { mcpServers } from "@/lib/db/schema";
import { requireOperator } from "@/lib/server/auth";
import { listMcpTools } from "@/lib/server/mcp";

export const dynamic = "force-dynamic";

/** Live preview: connect to a registered server and list its tools. */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireOperator();
  if (gate instanceof Response) return gate;
  const { id } = await params;
  const row = getDb().select().from(mcpServers).where(eq(mcpServers.id, id)).get();
  if (!row) return Response.json({ error: "Not found" }, { status: 404 });
  try {
    const tools = await listMcpTools({
      id: row.id,
      name: row.name,
      url: row.url,
      apiKey: row.apiKey,
      enabled: row.enabled,
    });
    return Response.json({ tools: tools.map((t) => ({ name: t.name, description: t.description })) });
  } catch (err) {
    return Response.json({ error: `Connection failed: ${String(err)}` }, { status: 502 });
  }
}
