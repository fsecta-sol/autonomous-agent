import { eq, lt } from "drizzle-orm";
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { getDb } from "./index";
import { authSessions, operators, type OperatorRow } from "./schema";

/** How long a login session stays valid, in days. */
export const SESSION_TTL_DAYS = 30;
const SESSION_TTL_MS = SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;

const SCRYPT_KEYLEN = 64;
const SCRYPT_SALT_BYTES = 16;

/** The client-safe operator view — never carries the password hash. */
export interface Operator {
  id: string;
  email: string;
  name: string;
  role: string;
  createdAt: number;
}

function toOperator(row: OperatorRow): Operator {
  return { id: row.id, email: row.email, name: row.name, role: row.role, createdAt: row.createdAt };
}

/** Emails are compared case-insensitively, so they're always stored lowercase. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** `scrypt$<saltHex>$<hashHex>` — self-describing so the scheme can evolve. */
export function hashPassword(password: string): string {
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

/** Constant-time compare of a candidate password against a stored hash. */
export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  if (expected.length === 0) return false;
  const actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return actual.length === expected.length && timingSafeEqual(expected, actual);
}

export interface CreateOperatorInput {
  email: string;
  name?: string;
  role?: string;
  password: string;
}

export function createOperator(input: CreateOperatorInput): Operator {
  const db = getDb();
  const id = randomUUID();
  db.insert(operators)
    .values({
      id,
      email: normalizeEmail(input.email),
      name: input.name?.trim() ?? "",
      role: input.role?.trim() || "Operator",
      passwordHash: hashPassword(input.password),
      createdAt: Date.now(),
    })
    .run();
  return toOperator(db.select().from(operators).where(eq(operators.id, id)).get()!);
}

/** The raw row (including the hash) — for the login route to verify against. */
export function findOperatorByEmail(email: string): OperatorRow | null {
  return getDb().select().from(operators).where(eq(operators.email, normalizeEmail(email))).get() ?? null;
}

export interface AuthSession {
  token: string;
  expiresAt: number;
}

/** Mint a new revocable session; the token is the primary key sent in the cookie. */
export function createAuthSession(operatorId: string): AuthSession {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  getDb().insert(authSessions).values({ id: token, operatorId, createdAt: now, expiresAt }).run();
  return { token, expiresAt };
}

/** The operator behind a session token, or null if it is missing or expired. */
export function getAuthSession(token: string): Operator | null {
  const db = getDb();
  const row = db
    .select({ session: authSessions, operator: operators })
    .from(authSessions)
    .innerJoin(operators, eq(authSessions.operatorId, operators.id))
    .where(eq(authSessions.id, token))
    .get();
  if (!row) return null;
  if (row.session.expiresAt <= Date.now()) {
    // Drop the dead row so it can't linger or be reused.
    db.delete(authSessions).where(eq(authSessions.id, token)).run();
    return null;
  }
  return toOperator(row.operator);
}

export function deleteAuthSession(token: string): boolean {
  return getDb().delete(authSessions).where(eq(authSessions.id, token)).run().changes > 0;
}

/** Remove every expired session row; returns how many were pruned. */
export function pruneExpiredSessions(now = Date.now()): number {
  return getDb().delete(authSessions).where(lt(authSessions.expiresAt, now)).run().changes;
}
