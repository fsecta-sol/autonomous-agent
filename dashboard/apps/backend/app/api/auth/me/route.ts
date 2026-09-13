import { getOperator } from "@/lib/server/auth";

export const dynamic = "force-dynamic";

/** The current operator's profile, or 401 when the session is absent/expired. */
export async function GET() {
  const operator = await getOperator();
  if (!operator) return Response.json({ error: "Unauthorized" }, { status: 401 });
  return Response.json({ operator });
}
