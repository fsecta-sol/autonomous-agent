import { NextRequest } from "next/server";
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
import { getSession } from "@/lib/db/sessions";

export const dynamic = "force-dynamic";

/** The agent service that actually runs the model↔tool loop. */
const AGENT_URL = (process.env.AGENT_URL || "http://127.0.0.1:8012").replace(/\/+$/, "");

/** The operator's answer to a pending tool-approval interrupt. */
interface ResumeBody {
  id?: string;
  decision: "approve" | "deny";
}

function readResume(value: unknown): ResumeBody | undefined {
  if (!value || typeof value !== "object") return undefined;
  const decision = (value as { decision?: unknown }).decision;
  if (decision !== "approve" && decision !== "deny") return undefined;
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
  if (sessionId) {
    const session = getSession(sessionId);
    if (session) history = asTurns(session.messages);
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
  const requested = typeof rawModel === "string" ? rawModel : undefined;

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

  // The full run config the stateless agent service needs.
  const payload = {
    agentId,
    llm: { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model },
    system,
    history,
    tools: tooling.builtins,
    mcp: tooling.mcp,
    terminalMode: tooling.terminalMode,
    allowUnsandboxed: process.env.TERMINAL_ALLOW_UNSANDBOXED === "1",
    warnings: tooling.warnings,
    // The agent uses this as its thread_id; empty ⇒ an ephemeral run.
    sessionId,
    resume,
  };

  let upstream: Response;
  try {
    upstream = await fetch(`${AGENT_URL}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: request.signal,
    });
  } catch (err) {
    sem.release();
    return Response.json({ error: "Agent service unavailable", detail: String(err) }, { status: 502 });
  }

  if (!upstream.ok || !upstream.body) {
    sem.release();
    return Response.json({ error: `Agent service HTTP ${upstream.status}` }, { status: 502 });
  }

  // Pass the agent's SSE through unchanged, holding the slot for the whole run.
  return new Response(releaseOnEnd(upstream.body, sem), {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

// A long tool round (or a sub-agent run) can leave the agent silent for well
// over the median, and an idle SSE stream gets dropped by intermediaries: the
// web app's Next.js rewrite proxy times the upstream out after 30s (its
// `experimental.proxyTimeout` default) and turns the drop into an HTTP 500.
// So we emit an SSE comment frame while nothing else flows. The browser's
// parser reads only `data:` lines, so this frame is invisible to the client.
const HEARTBEAT_MS = 10_000;
const HEARTBEAT_FRAME = new TextEncoder().encode(": keepalive\n\n");

/** Hold the concurrency slot for the whole conversation (across tool rounds). */
function releaseOnEnd(source: ReadableStream<Uint8Array>, sem: { release: () => void }): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let released = false;
  let closed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const stopTimer = () => {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
  const done = () => {
    if (released) return;
    released = true;
    stopTimer();
    sem.release();
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(HEARTBEAT_FRAME);
        } catch {
          stopTimer();
        }
      }, HEARTBEAT_MS);
    },
    async pull(controller) {
      try {
        const { value, done: finished } = await reader.read();
        if (finished) {
          closed = true;
          done();
          controller.close();
          return;
        }
        if (!closed) controller.enqueue(value);
      } catch (err) {
        closed = true;
        done();
        controller.error(err);
      }
    },
    cancel(reason) {
      closed = true;
      done();
      return reader.cancel(reason);
    },
  });
}
