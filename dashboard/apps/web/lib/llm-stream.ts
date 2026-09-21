import { LlmError } from "./llm-client";
import type { ToolStreamEvent, PermissionDecision, PermissionMode } from "@dashboard/shared";

/** A tool invocation event surfaced mid-stream (shared with the trace model). */
export type { ToolStreamEvent };

/** A protected tool's policy decision, surfaced mid-stream (the audit record). */
export interface PermissionEvent {
  type: "permission";
  tool: string;
  mode: PermissionMode;
  decision: PermissionDecision;
  /** "mode-change" when the decision came from a permission-mode switch, not an
   *  operator approval — the timeline says so and never reads it as consent. */
  reason?: "mode-change";
}

/** The session's tool-execution policy changed mid-run (an ASK→BYPASS switch). */
export interface ModeEvent {
  type: "mode";
  from: PermissionMode;
  to: PermissionMode;
  message?: string;
}

/** A run paused for the operator's approval before running a tool. */
export interface InterruptEvent {
  type: "interrupt";
  /** correlation id echoed back on resume */
  id: string | null;
  /** the tool awaiting approval (e.g. "run_command") */
  tool: string | null;
  args: Record<string, unknown>;
  message: string;
  /** the policy the paused run was asked under (always "ask" when an interrupt fires) */
  mode: PermissionMode;
  /** set once a mode switch has auto-resolved this pause: recorded history, but
   *  a re-attach must not re-raise its card */
  superseded?: boolean;
}

export interface StreamHandlers {
  /** a streamed answer delta */
  onText?: (text: string) => void;
  /** a streamed reasoning delta (only when the model emits reasoning) */
  onReasoning?: (text: string) => void;
  /** a tool started or finished (only when tools are enabled) */
  onTool?: (event: ToolStreamEvent) => void;
  /** a protected tool's policy decision (bypassed / pending) — the audit trail */
  onPermission?: (event: PermissionEvent) => void;
  /** the session's tool-execution policy changed mid-run */
  onMode?: (event: ModeEvent) => void;
  /** a non-fatal notice from the server (e.g. an unsandboxed-run warning) */
  onWarning?: (message: string) => void;
  /** the run paused awaiting approval; resume with `{ resume: { decision } }` */
  onInterrupt?: (event: InterruptEvent) => void;
  signal?: AbortSignal;
}

/** One decoded SSE envelope from the server's chat route. */
interface StreamEnvelope {
  type?: string;
  text?: string;
  message?: string;
  phase?: "start" | "end";
  name?: string;
  args?: Record<string, unknown>;
  result?: string;
  error?: boolean;
  id?: string | null;
  tool?: string | null;
  mode?: string;
  decision?: string;
  from?: string;
  to?: string;
  reason?: string;
  superseded?: boolean;
}

/**
 * Reads the server's SSE envelopes and dispatches them.
 *
 * The route re-encodes upstream output into a small protocol (rather than
 * passing the provider's raw SSE through) so the client can render both text
 * deltas and tool activity:
 *   {"type":"text","text":…} · {"type":"tool",…} · {"type":"error",…} · {"type":"done"}
 */
async function consumeStream(body: ReadableStream<Uint8Array>, handlers: StreamHandlers): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      for (const line of raw.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "") continue;
        let ev: StreamEnvelope;
        try {
          ev = JSON.parse(payload) as StreamEnvelope;
        } catch {
          continue;
        }
        if (ev.type === "text" && typeof ev.text === "string") {
          handlers.onText?.(ev.text);
        } else if (ev.type === "reasoning" && typeof ev.text === "string") {
          handlers.onReasoning?.(ev.text);
        } else if (ev.type === "tool" && (ev.phase === "start" || ev.phase === "end") && typeof ev.name === "string") {
          handlers.onTool?.({
            type: "tool",
            phase: ev.phase,
            name: ev.name,
            args: ev.args,
            result: ev.result,
            error: ev.error,
          });
        } else if (ev.type === "warning" && typeof ev.message === "string") {
          handlers.onWarning?.(ev.message);
        } else if (ev.type === "permission" && typeof ev.tool === "string") {
          const mode = ev.mode === "bypass" ? "bypass" : "ask";
          const decision =
            ev.decision === "bypassed" || ev.decision === "approved" || ev.decision === "rejected" || ev.decision === "denied"
              ? ev.decision
              : mode === "bypass"
                ? "bypassed"
                : "pending";
          handlers.onPermission?.({
            type: "permission",
            tool: ev.tool,
            mode,
            decision,
            reason: ev.reason === "mode-change" ? "mode-change" : undefined,
          });
        } else if (ev.type === "mode") {
          handlers.onMode?.({
            type: "mode",
            from: ev.from === "bypass" ? "bypass" : "ask",
            to: ev.to === "bypass" ? "bypass" : "ask",
            message: typeof ev.message === "string" ? ev.message : undefined,
          });
        } else if (ev.type === "interrupt") {
          handlers.onInterrupt?.({
            type: "interrupt",
            id: ev.id ?? null,
            tool: ev.tool ?? null,
            args: ev.args ?? {},
            message: typeof ev.message === "string" ? ev.message : "Approval required.",
            mode: ev.mode === "bypass" ? "bypass" : "ask",
            superseded: ev.superseded === true,
          });
        } else if (ev.type === "error") {
          throw new LlmError("http", typeof ev.message === "string" ? ev.message : "Stream error", 1);
        }
      }
    }
  }
}

/**
 * POST to a streaming route and dispatch its envelopes. Non-2xx responses are
 * read as JSON and rethrown as an {@link LlmError} carrying the HTTP status.
 */
export async function streamChatRequest<TBody>(path: string, body: TBody, handlers: StreamHandlers): Promise<void> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: handlers.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new LlmError("aborted", "Request cancelled", 1);
    }
    throw new LlmError("network", `Network error: ${String(err)}`, 1);
  }
  await consumeResponse(res, handlers);
}

/**
 * GET a streaming route and dispatch its envelopes — used to (re)attach to a
 * run that is already in flight. Same envelope protocol as the POST path, so a
 * reconnect replays the run from the start and follows it live.
 */
export async function streamAttachRequest(path: string, handlers: StreamHandlers): Promise<void> {
  let res: Response;
  try {
    res = await fetch(path, { method: "GET", signal: handlers.signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new LlmError("aborted", "Request cancelled", 1);
    }
    throw new LlmError("network", `Network error: ${String(err)}`, 1);
  }
  await consumeResponse(res, handlers);
}

/** Read a streaming response's envelopes, mapping failures to {@link LlmError}. */
async function consumeResponse(res: Response, handlers: StreamHandlers): Promise<void> {
  if (!res.ok) {
    let message = `Request failed with HTTP ${res.status}`;
    try {
      const data = (await res.json()) as { error?: string; detail?: string };
      if (data.error) message = data.detail ? `${data.error}: ${data.detail}` : data.error;
    } catch {
      // keep the status-based message
    }
    throw new LlmError("http", message, 1, res.status);
  }

  if (!res.body) {
    throw new LlmError("http", "Empty response body", 1, res.status);
  }

  try {
    await consumeStream(res.body, handlers);
  } catch (err) {
    if (err instanceof LlmError) throw err;
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new LlmError("aborted", "Request cancelled", 1);
    }
    throw new LlmError("network", `Stream interrupted: ${String(err)}`, 1);
  }
}
