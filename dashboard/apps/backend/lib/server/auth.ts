import { cookies } from "next/headers";
import { getAuthSession, SESSION_TTL_DAYS, type Operator } from "@/lib/db/auth";

/** The cookie carrying the opaque session token. */
export const SESSION_COOKIE = "agent-session";

const SESSION_MAX_AGE = SESSION_TTL_DAYS * 24 * 60 * 60;

/** Cookie attributes shared by set/clear so they always agree. */
export function sessionCookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge,
  };
}

/** Persist a freshly minted session token on the outgoing response. */
export async function setSessionCookie(token: string): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, sessionCookieOptions(SESSION_MAX_AGE));
}

/** Drop the session cookie (the DB row is deleted separately by the caller). */
export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, "", sessionCookieOptions(0));
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
