import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { WorkspaceClient } from "@/components/layout/WorkspaceClient";

/** The API backend that owns the session. The browser reaches it via the
 *  `/api/*` rewrite; this server component calls it directly, cookie forwarded. */
const BACKEND_URL = process.env.BACKEND_URL || "http://127.0.0.1:3011";

/**
 * The authoritative gate. `proxy.ts` only checks cookie presence; here we ask
 * the backend whether the session is actually valid before rendering.
 */
export default async function WorkspacePage() {
  const cookieHeader = (await cookies()).toString();
  let authed = false;
  try {
    const res = await fetch(`${BACKEND_URL}/api/auth/me`, {
      headers: { cookie: cookieHeader },
      cache: "no-store",
    });
    authed = res.ok;
  } catch {
    authed = false; // backend unreachable → treat as signed out
  }
  if (!authed) redirect("/login");
  return <WorkspaceClient />;
}
