import { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { getSemaphore } from "@/lib/server/semaphore";
import {
  findAgent,
  persona,
  readUpstreamConfig,
  resolveEffectiveConnection,
  resolveModel,
  sanitizeMessages,
} from "@/lib/server/llm-provider";
import { requireOperator } from "@/lib/server/auth";
import { resolveAgentTooling } from "@/lib/server/agent-config";
import { resolvePermissionMode } from "@/lib/server/permission";
import { getSession } from "@/lib/db/sessions";
import {
  claimResume,
  getRun,
  killRun,
  noteModeChangeResume,
  pumpRun,
  resumeRun,
  runStream,
  startRun,
  type ActiveRun,
} from "@/lib/server/runs";

export const dynamic = "force-dynamic";

/** The agent service that actually runs the model↔tool loop. */
const AGENT_URL = (process.env.AGENT_URL || "http://127.0.0.1:8012").replace(/\/+$/, "");

/**
 * The operator's answer to a pending tool-approval interrupt.
 *   approve — run the tool.
 *   deny    — do not run it; the turn continues.
 *   bypass  — resolve the pause under the session's CURRENT policy. The backend
 *             re-resolves the mode; if it is now `bypass`, the resumed tool runs
 *             without the interactive gate (the graph rebuilds in bypass). This
 *             is what an ASK→BYPASS switch sends to continue a pending request —
 *             it is NOT an operator approval, and the audit trail says so.
 */
interface ResumeBody {
  id?: string;
  decision: "approve" | "deny" | "bypass";
}

function readResume(value: unknown): ResumeBody | undefined {
  if (!value || typeof value !== "object") return undefined;
  const decision = (value as { decision?: unknown }).decision;
  if (decision !== "approve" && decision !== "deny" && decision !== "bypass") return undefined;
  const id = (value as { id?: unknown }).id;
  return { id: typeof id === "string" ? id : undefined, decision };
}

/**
 * The chat route. It resolves everything the run needs (agent persona, skills,
 * tool set, MCP servers, upstream credentials) from the database, then hands
 * that off to the agent service, which streams back our SSE envelope protocol.
 * This route never talks to the LLM itself.
 *
 * The transcript comes from our own `messages` table (not the client) when a
 * `sessionId` is present, so the agent's checkpoint and our display log cannot
 * drift. A `resume` continues a run that paused for tool approval.
 *
 * The run is owned by the backend, not the browser: the upstream fetch is not
 * tied to this request's signal, and a detached pump drives it. A client that
 * leaves or reloads does not tear the run down — it detaches, and can reattach
 * (see `/api/chats/[id]/run`) to replay + follow the same run.
 */
export async function POST(request: NextRequest) {
  const gate = await requireOperator();
  if (gate instanceof Response) return gate;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Malformed JSON body" }, { status: 400 });
  }

  const agentId = typeof (body as { agentId?: unknown })?.agentId === "string" ? (body as { agentId: string }).agentId : "";
  const sessionId = typeof (body as { sessionId?: unknown })?.sessionId === "string" ? (body as { sessionId: string }).sessionId : "";
  const resume = readResume((body as { resume?: unknown })?.resume);

  // An agent may carry its own endpoint + key; otherwise the server env is used.
  const envCfg = readUpstreamConfig();
  const cfg = resolveEffectiveConnection(envCfg, agentId);
  if (!cfg.apiKey) {
    return Response.json(
      { error: "AI not configured", detail: "Set LLM_API_KEY on the server, or give the agent its own endpoint and key." },
      { status: 501 },
    );
  }

  // One run per session. A resume continues the SAME run (the one that paused
  // for approval); a fresh turn while one is in flight is a conflict.
  const runKey = sessionId || `ephemeral-${randomUUID()}`;
  const existing = getRun(runKey);
  if (existing && !(resume && existing.paused)) {
    return Response.json({ error: "A run is already active for this chat" }, { status: 409 });
  }

  const messages = sanitizeMessages((body as { messages?: unknown })?.messages);
  // A resume carries no new turn; only a fresh turn requires messages.
  if (!resume && messages.length === 0 && !sessionId) {
    return Response.json({ error: "messages is required" }, { status: 400 });
  }
  // the model never sees the client's "system" turns — persona is set here
  interface Turn {
    role: "user" | "assistant";
    content: string;
  }
  const asTurns = (rows: Array<{ role: string; content: string }>): Turn[] =>
    rows.filter((m) => m.role === "user" || m.role === "assistant").map((m) => ({ role: m.role as Turn["role"], content: m.content }));

  // Prefer our own persisted transcript so the agent's memory and the stored
  // log agree. The client persists the new user turn before calling us, so it
  // is already the last row here.
  let history: Turn[] = asTurns(messages);
  /** the session's own model override, used when the request carries none */
  let sessionModel: string | undefined;
  /** the session's explicit tool-execution policy (null = inherit the agent's) */
  let sessionPermission: ReturnType<typeof resolvePermissionMode> | null = null;
  if (sessionId) {
    const session = getSession(sessionId);
    if (session) {
      history = asTurns(session.messages);
      sessionModel = session.model || undefined;
      sessionPermission = session.permissionMode;
    }
  }

  const agent = findAgent(agentId);
  const tooling = resolveAgentTooling(agentId);
  let system = agent ? persona(agent) : "You are a helpful research assistant.";
  if (tooling.skillPrompt) system += `\n\n## Applied skills\n\n${tooling.skillPrompt}`;

  // Composer modes: pure system-prompt directives, no upstream-specific flags.
  const reasoning = (body as { reasoning?: unknown })?.reasoning === true;
  const research = (body as { research?: unknown })?.research === true;
  if (reasoning) {
    system += `\n\n## Reasoning mode\nWork through the problem step by step before your final answer: lay out the key steps, then state the conclusion clearly.`;
  }
  if (research) {
    system += `\n\n## Deep research mode\nResearch before answering. Use your available tools to gather evidence from multiple sources, then cite the specific sources you relied on. Flag anything you could not verify.`;
  }

  const rawModel = (body as { model?: unknown })?.model;
  // The request's model wins; otherwise the session's stored choice; otherwise
  // the server resolves it (env default, then endpoint auto-detect).
  const requested = typeof rawModel === "string" && rawModel.trim() ? rawModel.trim() : sessionModel;

  let model: string;
  try {
    model = (await resolveModel(cfg, requested)).model;
  } catch (err) {
    return Response.json(
      { error: "No model available", detail: `Could not list models from the endpoint: ${String(err)}` },
      { status: 502 },
    );
  }

  const sem = getSemaphore(cfg.maxConcurrency);
  const acquired = await sem.acquire(2_000);
  if (!acquired) {
    return Response.json({ error: "Server busy" }, { status: 503, headers: { "Retry-After": "2" } });
  }

  // The effective tool-execution policy for this run: the session's override,
  // else the agent's default, else "ask". Resolved fresh on EVERY dispatch —
  // including a resume — so an ASK→BYPASS switch while a request is pending
  // takes effect on that request (the agent rebuilds its tool from this and the
  // replayed tool node then runs without a gate). It is never applied
  // retroactively to a tool call that already settled.
  const effectivePermission = resolvePermissionMode(sessionPermission, tooling.permissionMode);

  // A resume reuses the paused run (keeping its accumulators so the turn
  // persists once, whole); a fresh turn starts a new one.
  let run: ActiveRun;
  let fromIndex = 0;
  if (resume && existing && existing.paused) {
    // A `bypass` decision asks to resolve the pending request under the session's
    // CURRENT policy. The backend is authoritative: it only proceeds when the
    // session is actually in bypass — otherwise the request stays pending and the
    // caller is told, rather than the run being driven with a contradictory value.
    if (resume.decision === "bypass" && effectivePermission !== "bypass") {
      sem.release();
      return Response.json(
        { error: "Session is not in BYPASS mode", detail: "The pending request remains awaiting approval." },
        { status: 409 },
      );
    }
    // Exactly one resume may drive the run. If an operator approval and a mode
    // switch race, the loser is told the request already resolved — the tool runs
    // once, with a single terminal transition.
    if (!claimResume(existing)) {
      sem.release();
      return Response.json({ error: "The pending approval was already resolved" }, { status: 409 });
    }
    const prevMode = existing.permissionMode;
    // Hold the client's resume point before the audit envelopes, so a switch —
    // which is recorded in the log — is replayed to the client alongside the run.
    const heldBefore = existing.events.length;
    if (resume.decision === "bypass" && prevMode !== "bypass") {
      noteModeChangeResume(existing, prevMode, "bypass");
    }
    existing.permissionMode = effectivePermission;
    run = resumeRun(existing);
    fromIndex = heldBefore;
  } else {
    const created = startRun(runKey, effectivePermission);
    if (!created) {
      // Lost the race with another POST for the same session.
      sem.release();
      return Response.json({ error: "A run is already active for this chat" }, { status: 409 });
    }
    run = created;
  }

  // The full run config the stateless agent service needs.
  const payload = {
    agentId,
    llm: { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model },
    system,
    history,
    tools: tooling.builtins,
    mcp: tooling.mcp,
    terminalMode: tooling.terminalMode,
    // The policy THIS dispatch runs under (re-resolved above; a resume carries
    // the session's current mode, not the one frozen when the run first started).
    permissionMode: run.permissionMode,
    allowUnsandboxed: process.env.TERMINAL_ALLOW_UNSANDBOXED === "1",
    warnings: tooling.warnings,
    // The agent uses this as its thread_id; empty ⇒ an ephemeral run.
    sessionId: runKey,
    // The agent's contract stays approve/deny. A `bypass` decision means "run
    // the replayed tool under the session's current policy": the graph rebuilds
    // in bypass, so the tool node never calls interrupt() and this value is
    // unused — `approve` is the honest placeholder (the request WAS cleared).
    resume: resume ? { id: resume.id, decision: resume.decision === "deny" ? "deny" : "approve" } : undefined,
  };

  let upstream: Response;
  try {
    // The fetch is tied to the run's own controller, NOT `request.signal`: the
    // run outlives this request, and Stop aborts it via this controller.
    upstream = await fetch(`${AGENT_URL}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: run.controller.signal,
    });
  } catch (err) {
    // A failed resume restores the paused run for a retry (and releases the
    // claim so the operator or a switch can try again); a failed fresh run is
    // dropped entirely.
    if (resume) {
      run.paused = true;
      run.resuming = false;
    } else killRun(runKey);
    sem.release();
    return Response.json({ error: "Agent service unavailable", detail: String(err) }, { status: 502 });
  }

  if (!upstream.ok || !upstream.body) {
    if (resume) {
      run.paused = true;
      run.resuming = false;
    } else killRun(runKey);
    sem.release();
    return Response.json({ error: `Agent service HTTP ${upstream.status}` }, { status: 502 });
  }

  // Drive the run detached; the semaphore is held for its whole lifetime.
  void pumpRun(run, upstream.body).finally(() => sem.release());

  return new Response(runStream(run, fromIndex), {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
