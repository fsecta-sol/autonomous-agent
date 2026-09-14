import { cookies, headers } from "next/headers";
import { getAuthSession, SESSION_TTL_DAYS, type Operator } from "@/lib/db/auth";

/** The cookie carrying the opaque session token. */
export const SESSION_COOKIE = "agent-session";

const SESSION_MAX_AGE = SESSION_TTL_DAYS * 24 * 60 * 60;

/**
 * Whether to mark the session cookie `Secure`. A Secure cookie is only sent back
 * over HTTPS, so forcing it on a plain-HTTP deployment (this one — LAN, no TLS)
 * makes every request after login unauthenticated: the browser never returns the
 * cookie, so the app looks logged-in for one response and 401s thereafter.
 *
 * So: Secure only when the request actually arrived over HTTPS. Behind a real
 * TLS terminator, override with `SESSION_COOKIE_SECURE=1` (or `=0` to force off).
 * Note `NODE_ENV` is deliberately NOT used — `next start` is production and this
 * host serves plain HTTP, which is exactly the mismatch this avoids.
 */
async function cookieSecure(): Promise<boolean> {
  const override = process.env.SESSION_COOKIE_SECURE;
  if (override === "1") return true;
  if (override === "0") return false;
  const h = await headers();
  const proto = h.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  return proto === "https";
}

/** Cookie attributes shared by set/clear so they always agree. */
export function sessionCookieOptions(maxAge: number, secure: boolean) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure,
    path: "/",
    maxAge,
  };
}

/** Persist a freshly minted session token on the outgoing response. */
export async function setSessionCookie(token: string): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, sessionCookieOptions(SESSION_MAX_AGE, await cookieSecure()));
}

/** Drop the session cookie (the DB row is deleted separately by the caller). */
export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, "", sessionCookieOptions(0, await cookieSecure()));
}

/**
 * Resolve the signed-in operator from the session cookie, or null. This is the
 * authoritative check — it validates the DB row and its expiry, unlike the
 * cookie-presence check in `proxy.ts`.
 */
export async function getOperator(): Promise<Operator | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return getAuthSession(token);
}

/**
 * Route-handler gate: return the operator, or a ready-to-return 401. Callers do
 * `const gate = await requireOperator(); if (gate instanceof Response) return gate;`.
 */
export async function requireOperator(): Promise<Operator | Response> {
  const operator = await getOperator();
  if (!operator) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  return operator;
}

/** The current session token, if any — for logout to revoke the right row. */
export async function currentSessionToken(): Promise<string | null> {
  const store = await cookies();
  return store.get(SESSION_COOKIE)?.value ?? null;
}
