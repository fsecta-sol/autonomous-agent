import { and, desc, eq, asc, gt, gte, inArray, like, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getDb } from "./index";
import { sessions, messages, type SessionRow, type MessageRow } from "./schema";
import type { PermissionMode } from "@dashboard/shared";

export interface ChatMessage {
  id: string;
  role: "system" | "user" | "assistant";
  content: string;
  links: string[] | null;
  /** recorded SSE envelopes for this turn, for the client to rebuild the trace */
  events: unknown[] | null;
  seq: number;
  createdAt: number;
}

export interface SessionSummary {
  id: string;
  agentId: string;
  title: string;
  model: string | null;
  /** per-session tool-execution policy; null = inherit the agent's default */
  permissionMode: PermissionMode | null;
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
  let events: unknown[] | null = null;
  if (row.events) {
    try {
      const parsed = JSON.parse(row.events);
      if (Array.isArray(parsed)) events = parsed;
    } catch {
      /* malformed — treat as no events */
    }
  }
  return { id: row.id, role: row.role, content: row.content, links, events, seq: row.seq, createdAt: row.createdAt };
}

function toSummary(row: SessionRow, messageCount: number): SessionSummary {
  return {
    id: row.id,
    agentId: row.agentId,
    title: row.title,
    model: row.model,
    permissionMode: row.permissionMode ?? null,
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
  patch: {
    title?: string;
    model?: string | null;
    /** per-session tool-execution policy; null = clear the override (inherit) */
    permissionMode?: PermissionMode | null;
    pinned?: boolean;
    archived?: boolean;
  },
): SessionDetail | null {
  const db = getDb();
  const existing = db.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, id)).get();
  if (!existing) return null;
  const values: Partial<SessionRow> = { updatedAt: now() };
  if (patch.title !== undefined) values.title = patch.title.trim() || "New chat";
  if (patch.model !== undefined) values.model = patch.model;
  if (patch.permissionMode !== undefined) values.permissionMode = patch.permissionMode;
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
 * Delete many sessions in one statement. Messages/checkpoints cascade from the
 * schema, so this is the whole removal. Returns the ids that actually existed —
 * an id already gone is silently absent from the result, so a caller can report
 * a truthful "deleted N of M" without a partial failure.
 */
export function deleteSessions(ids: string[]): string[] {
  const clean = [...new Set(ids.filter((x) => typeof x === "string" && x.length > 0))];
  if (!clean.length) return [];
  const db = getDb();
  const existing = db
    .select({ id: sessions.id })
    .from(sessions)
    .where(inArray(sessions.id, clean))
    .all()
    .map((r) => r.id);
  if (!existing.length) return [];
  db.delete(sessions).where(inArray(sessions.id, existing)).run();
  return existing;
}

/**
 * Append a turn. `seq` continues the session's existing order; the session's
 * updatedAt is bumped so it floats to the top of the list.
 */
export function appendMessage(
  sessionId: string,
  msg: { role: ChatMessage["role"]; content: string; links?: string[] | null; events?: string | null; id?: string },
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
      events: msg.events ?? null,
      createdAt: t,
    })
    .run();
  db.update(sessions).set({ updatedAt: t }).where(eq(sessions.id, sessionId)).run();
  return toMessage({
    id,
    sessionId,
    seq,
    role: msg.role,
    content: msg.content,
    links: msg.links && msg.links.length ? JSON.stringify(msg.links) : null,
    events: msg.events ?? null,
    createdAt: t,
  });
}

/**
 * Recent assistant turns across every session, oldest first, each with the
 * session's agent id and its recorded event log. Telemetry folds these into
 * per-agent throughput, error rate and latency — the same rows the UI replays.
 */
export interface RecentTurn {
  agentId: string;
  sessionId: string;
  content: string;
  events: unknown[] | null;
  createdAt: number;
}

export function recentAssistantTurns(sinceMs: number, limit = 2000): RecentTurn[] {
  const db = getDb();
  const rows = db
    .select({
      agentId: sessions.agentId,
      sessionId: messages.sessionId,
      content: messages.content,
      events: messages.events,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .innerJoin(sessions, eq(messages.sessionId, sessions.id))
    .where(and(eq(messages.role, "assistant"), gte(messages.createdAt, sinceMs)))
    .orderBy(desc(messages.createdAt))
    .limit(limit)
    .all();
  const parsed = rows.map((r) => {
    let events: unknown[] | null = null;
    if (r.events) {
      try {
        const p = JSON.parse(r.events);
        if (Array.isArray(p)) events = p;
      } catch {
        /* malformed — treated as no log */
      }
    }
    return { agentId: r.agentId, sessionId: r.sessionId, content: r.content, events, createdAt: r.createdAt };
  });
  // newest-first from SQL, oldest-first for the caller
  return parsed.reverse();
}

/**
 * Map a set of session ids to the agent each belongs to ("" = unassigned).
 * Telemetry uses this to attribute an in-flight run to its agent without
 * relying on the run having already persisted a turn.
 */
export function sessionAgentMap(ids: string[]): Map<string, string> {
  if (!ids.length) return new Map();
  const db = getDb();
  const rows = db
    .select({ id: sessions.id, agentId: sessions.agentId })
    .from(sessions)
    .where(inArray(sessions.id, ids))
    .all();
  return new Map(rows.map((r) => [r.id, r.agentId]));
}

/** Derive a short title from the first user message (no LLM call needed). */
export function titleFromText(text: string): string {
  const clean = text.replace(/\s+/g, " ").replace(/^[-*\d.\s]+/, "").trim();
  if (!clean) return "New chat";
  return clean.length > 60 ? clean.slice(0, 57).trimEnd() + "…" : clean;
}

/**
 * Trim a session's transcript to end after `seq` (inclusive) — the anchor a
 * regenerate or edit-and-resend rewinds to. Every message with a higher seq is
 * dropped, so the next run re-seeds the model from exactly this tail. Returns
 * the session as it now stands. A `seq` below the session's first message
 * clears every message, which is a valid (empty) rewind.
 */
export function rewindSession(sessionId: string, seq: number): SessionDetail | null {
  const db = getDb();
  const exists = db.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, sessionId)).get();
  if (!exists) return null;
  db.delete(messages)
    .where(and(eq(messages.sessionId, sessionId), gt(messages.seq, seq)))
    .run();
  db.update(sessions).set({ updatedAt: now() }).where(eq(sessions.id, sessionId)).run();
  return getSession(sessionId);
}

/**
 * Rewrite one persisted turn's content in place (used by edit-and-resend, which
 * replaces the user turn before re-running). No-op when the row is not found.
 */
export function updateMessageContent(sessionId: string, seq: number, content: string): boolean {
  const db = getDb();
  const res = db
    .update(messages)
    .set({ content })
    .where(and(eq(messages.sessionId, sessionId), eq(messages.seq, seq)))
    .run();
  return res.changes > 0;
}
