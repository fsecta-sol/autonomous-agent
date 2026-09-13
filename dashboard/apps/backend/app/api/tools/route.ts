import { toolCatalog } from "@/lib/server/tool-catalog";
import { requireOperator } from "@/lib/server/auth";

export const dynamic = "force-dynamic";

/** The builtin tools, plus whether this server permits unsandboxed terminal runs. */
export async function GET() {
  const gate = await requireOperator();
  if (gate instanceof Response) return gate;
  return Response.json({
    tools: toolCatalog(),
    allowUnsandboxed: process.env.TERMINAL_ALLOW_UNSANDBOXED === "1",
  });
}
