import { LlmError } from "./llm-client";

/** A tool invocation event surfaced mid-stream. */
export interface ToolStreamEvent {
  type: "tool";
  phase: "start" | "end";
  name: string;
  args?: Record<string, unknown>;
  result?: string;
  error?: boolean;
}

export interface StreamHandlers {
  /** a streamed answer delta */
  onText?: (text: string) => void;
  /** a streamed reasoning delta (only when the model emits reasoning) */
  onReasoning?: (text: string) => void;
  /** a tool started or finished (only when tools are enabled) */
  onTool?: (event: ToolStreamEvent) => void;
  /** a non-fatal notice from the server (e.g. an unsandboxed-run warning) */
  onWarning?: (message: string) => void;
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
