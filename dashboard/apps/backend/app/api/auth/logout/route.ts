import { deleteAuthSession } from "@/lib/db/auth";
import { clearSessionCookie, currentSessionToken } from "@/lib/server/auth";

export const dynamic = "force-dynamic";

/** Revoke the session row (if any) and clear the cookie. Always succeeds. */
export async function POST() {
  const token = await currentSessionToken();
  if (token) deleteAuthSession(token);
  await clearSessionCookie();
  return Response.json({ ok: true });
}
