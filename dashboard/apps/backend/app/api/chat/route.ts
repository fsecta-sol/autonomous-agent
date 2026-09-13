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

export const dynamic = "force-dynamic";

/** The agent service that actually runs the model↔tool loop. */
const AGENT_URL = (process.env.AGENT_URL || "http://127.0.0.1:8012").replace(/\/+$/, "");

/**
 * The chat route. It resolves everything the run needs (agent persona, skills,
 * tool set, MCP servers, upstream credentials) from the database, then hands
 * that off to the agent service, which streams back our SSE envelope protocol.
 * This route never talks to the LLM itself.
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
  if (messages.length === 0) {
    return Response.json({ error: "messages is required" }, { status: 400 });
  }
  // the model never sees the client's "system" turns — persona is set here
  const history = messages
    .filter((m): m is { role: "user" | "assistant"; content: string } => m.role !== "system")
    .map((m) => ({ role: m.role, content: m.content }));

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

/** Hold the concurrency slot for the whole conversation (across tool rounds). */
function releaseOnEnd(source: ReadableStream<Uint8Array>, sem: { release: () => void }): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let released = false;
  const done = () => {
    if (released) return;
    released = true;
    sem.release();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done: finished } = await reader.read();
        if (finished) {
          done();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        done();
        controller.error(err);
      }
    },
    cancel(reason) {
      done();
      return reader.cancel(reason);
    },
  });
}
