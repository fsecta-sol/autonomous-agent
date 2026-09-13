import { NextRequest } from "next/server";
import { createAuthSession, createOperator, findOperatorByEmail } from "@/lib/db/auth";
import { setSessionCookie } from "@/lib/server/auth";

export const dynamic = "force-dynamic";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;

interface SignupBody {
  name?: unknown;
  email?: unknown;
  password?: unknown;
}

/** Open signup: create an operator, start a session, return the profile. */
export async function POST(request: NextRequest) {
  let body: SignupBody;
  try {
    body = (await request.json()) as SignupBody;
  } catch {
    return Response.json({ error: "Malformed JSON body" }, { status: 400 });
  }

  const email = typeof body.email === "string" ? body.email.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";

  if (!EMAIL_RE.test(email)) {
    return Response.json({ error: "Enter a valid email address." }, { status: 400 });
  }
  if (password.length < MIN_PASSWORD) {
    return Response.json({ error: `Password must be at least ${MIN_PASSWORD} characters.` }, { status: 400 });
  }
  if (findOperatorByEmail(email)) {
    return Response.json({ error: "An account with that email already exists." }, { status: 409 });
  }

  const operator = createOperator({ email, name, role: "Swarm operator", password });
  const session = createAuthSession(operator.id);
  await setSessionCookie(session.token);

  return Response.json({ operator }, { status: 201 });
}
