import { and, desc, eq, asc, like, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getDb } from "./index";
import { sessions, messages, type SessionRow, type MessageRow } from "./schema";

export interface ChatMessage {
  id: string;
  role: "system" | "user" | "assistant";
  content: string;
  links: string[] | null;
  seq: number;
  createdAt: number;
}

export interface SessionSummary {
  id: string;
  agentId: string;
  title: string;
  model: string | null;
  pinned: boolean;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export interface SessionDetail extends SessionSummary {
  messages: ChatMessage[];
}

export interface ListOptions {
  agentId?: string;
  search?: string;
  includeArchived?: boolean;
  limit?: number;
}

const now = () => Date.now();

function toMessage(row: MessageRow): ChatMessage {
  let links: string[] | null = null;
  if (row.links) {
    try {
      const parsed = JSON.parse(row.links);
      if (Array.isArray(parsed)) links = parsed.filter((x): x is string => typeof x === "string");
    } catch {
      /* malformed — treat as no links */
    }
  }
  return { id: row.id, role: row.role, content: row.content, links, seq: row.seq, createdAt: row.createdAt };
}

function toSummary(row: SessionRow, messageCount: number): SessionSummary {
  return {
    id: row.id,
    agentId: row.agentId,
    title: row.title,
    model: row.model,
    pinned: row.pinned,
    archived: row.archived,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    messageCount,
  };
}

export function listSessions(opts: ListOptions = {}): SessionSummary[] {
  const db = getDb();
  const conds = [];
  if (opts.agentId) conds.push(eq(sessions.agentId, opts.agentId));
  if (!opts.includeArchived) conds.push(eq(sessions.archived, false));
  if (opts.search) conds.push(like(sessions.title, `%${opts.search}%`));

  const rows = db
    .select()
    .from(sessions)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(sessions.pinned), desc(sessions.updatedAt))
    .limit(Math.min(Math.max(opts.limit ?? 100, 1), 5000))
    .all();

  const counts = db
    .select({ sessionId: messages.sessionId, n: sql<number>`count(*)` })
    .from(messages)
    .groupBy(messages.sessionId)
    .all();
  const countMap = new Map(counts.map((c) => [c.sessionId, Number(c.n)]));

  return rows.map((r) => toSummary(r, countMap.get(r.id) ?? 0));
}

export function getSession(id: string): SessionDetail | null {
  const db = getDb();
  const row = db.select().from(sessions).where(eq(sessions.id, id)).get();
  if (!row) return null;
  const msgs = db
    .select()
    .from(messages)
    .where(eq(messages.sessionId, id))
    .orderBy(asc(messages.seq))
    .all();
  return { ...toSummary(row, msgs.length), messages: msgs.map(toMessage) };
}

export function createSession(input: { agentId?: string; title?: string; model?: string | null } = {}): SessionDetail {
  const db = getDb();
  const id = randomUUID();
  const t = now();
  db.insert(sessions)
    .values({
      id,
      agentId: input.agentId ?? "",
      title: input.title?.trim() || "New chat",
      model: input.model ?? null,
      createdAt: t,
      updatedAt: t,
    })
    .run();
  return getSession(id)!;
}

export function updateSession(
  id: string,
  patch: { title?: string; model?: string | null; pinned?: boolean; archived?: boolean },
): SessionDetail | null {
  const db = getDb();
  const existing = db.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, id)).get();
  if (!existing) return null;
  const values: Partial<SessionRow> = { updatedAt: now() };
  if (patch.title !== undefined) values.title = patch.title.trim() || "New chat";
  if (patch.model !== undefined) values.model = patch.model;
  if (patch.pinned !== undefined) values.pinned = patch.pinned;
  if (patch.archived !== undefined) values.archived = patch.archived;
  db.update(sessions).set(values).where(eq(sessions.id, id)).run();
  return getSession(id);
}

export function deleteSession(id: string): boolean {
  const db = getDb();
  const res = db.delete(sessions).where(eq(sessions.id, id)).run();
  return res.changes > 0;
}

/**
 * Append a turn. `seq` continues the session's existing order; the session's
 * updatedAt is bumped so it floats to the top of the list.
 */
export function appendMessage(
  sessionId: string,
  msg: { role: ChatMessage["role"]; content: string; links?: string[] | null; id?: string },
): ChatMessage | null {
  const db = getDb();
  const exists = db.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, sessionId)).get();
  if (!exists) return null;

  const max = db
    .select({ m: sql<number | null>`max(${messages.seq})` })
    .from(messages)
    .where(eq(messages.sessionId, sessionId))
    .get();
  const seq = (max?.m ?? -1) + 1;

  const id = msg.id ?? randomUUID();
  const t = now();
  db.insert(messages)
    .values({
      id,
      sessionId,
      seq,
      role: msg.role,
      content: msg.content,
      links: msg.links && msg.links.length ? JSON.stringify(msg.links) : null,
      createdAt: t,
    })
    .run();
  db.update(sessions).set({ updatedAt: t }).where(eq(sessions.id, sessionId)).run();
  return { id, role: msg.role, content: msg.content, links: msg.links ?? null, seq, createdAt: t };
}

/** Derive a short title from the first user message (no LLM call needed). */
export function titleFromText(text: string): string {
  const clean = text.replace(/\s+/g, " ").replace(/^[-*\d.\s]+/, "").trim();
  if (!clean) return "New chat";
  return clean.length > 60 ? clean.slice(0, 57).trimEnd() + "…" : clean;
}
