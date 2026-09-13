import { NextResponse, type NextRequest } from "next/server";

/** Must match the cookie the backend sets (apps/backend/lib/server/auth.ts). */
const SESSION_COOKIE = "agent-session";

/**
 * Fast, edge-safe gate: when the session cookie is absent, send page requests
 * to `/login` and answer API requests with 401. It only checks cookie presence
 * (no DB) — `app/page.tsx` and each backend route re-validate the session
 * against the database, which is the authoritative check.
 *
 * API paths get a 401 rather than a redirect: following a redirect would return
 * the `/login` HTML with a 200, which a `fetch()` caller would mistake for data.
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (request.cookies.has(SESSION_COOKIE)) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = request.nextUrl.clone();
  url.pathname = "/login";
  return NextResponse.redirect(url);
}

export const config = {
  // Everything except the auth pages, the auth API, and static assets.
  matcher: ["/((?!login|sign-up|api/auth|_next/static|_next/image|favicon.ico).*)"],
};
