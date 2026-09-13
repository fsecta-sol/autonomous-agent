import { NextRequest } from "next/server";
import { createAuthSession, findOperatorByEmail, verifyPassword, type Operator } from "@/lib/db/auth";
import { setSessionCookie } from "@/lib/server/auth";

export const dynamic = "force-dynamic";

interface LoginBody {
  email?: unknown;
  password?: unknown;
}

/** A single message for every failure so callers can't tell which half was wrong. */
const INVALID = "Invalid email or password.";

/** Verify credentials and start a revocable session. */
export async function POST(request: NextRequest) {
  let body: LoginBody;
  try {
    body = (await request.json()) as LoginBody;
  } catch {
    return Response.json({ error: "Malformed JSON body" }, { status: 400 });
  }

  const email = typeof body.email === "string" ? body.email.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!email || !password) {
    return Response.json({ error: INVALID }, { status: 401 });
  }

  const row = findOperatorByEmail(email);
  if (!row || !verifyPassword(password, row.passwordHash)) {
    return Response.json({ error: INVALID }, { status: 401 });
  }

  const operator: Operator = {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    createdAt: row.createdAt,
  };
  const session = createAuthSession(operator.id);
  await setSessionCookie(session.token);

  return Response.json({ operator });
}
