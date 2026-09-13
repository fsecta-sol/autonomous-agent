import { NextRequest } from "next/server";
import { appendMessage, getSession, titleFromText, updateSession } from "@/lib/db/sessions";
import type { ChatMessage } from "@/lib/db/sessions";
import { requireOperator } from "@/lib/server/auth";

export const dynamic = "force-dynamic";

const ROLES = new Set<ChatMessage["role"]>(["system", "user", "assistant"]);

/** Append one turn to a session. Titles the session from its first user turn. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireOperator();
  if (gate instanceof Response) return gate;
  const { id } = await params;
  let body: { role?: unknown; content?: unknown; links?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Malformed JSON body" }, { status: 400 });
  }

  const role = body.role;
  if (typeof role !== "string" || !ROLES.has(role as ChatMessage["role"])) {
    return Response.json({ error: "role must be system|user|assistant" }, { status: 400 });
  }
  const content = typeof body.content === "string" ? body.content : "";
  const links = Array.isArray(body.links) ? body.links.filter((x): x is string => typeof x === "string") : null;

  const existing = getSession(id);
  if (!existing) return Response.json({ error: "Not found" }, { status: 404 });

  const message = appendMessage(id, { role: role as ChatMessage["role"], content, links });
  if (!message) return Response.json({ error: "Not found" }, { status: 404 });

  // first user turn names the session
  if (role === "user" && existing.messageCount === 0 && existing.title === "New chat") {
    updateSession(id, { title: titleFromText(content) });
  }

  return Response.json(message, { status: 201 });
}
