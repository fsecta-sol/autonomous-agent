import { NextRequest } from "next/server";
import { getSemaphore } from "@/lib/server/semaphore";
import { requireOperator } from "@/lib/server/auth";
import {
  chatCompletionsUrl,
  readUpstreamConfig,
  resolveModel,
  upstreamHeaders,
} from "@/lib/server/llm-provider";

interface ResearchBody {
  thought?: unknown;
  depth?: unknown;
}

interface ResearchResponse {
  summary: string;
  connections: string[];
  layer: string | null;
}

const DEPTH_HINT: Record<string, string> = {
  quick: "one or two sentences",
  standard: "a short paragraph",
  deep: "a thorough paragraph",
};

export async function POST(request: NextRequest) {
  const gate = await requireOperator();
  if (gate instanceof Response) return gate;
  const cfg = readUpstreamConfig();
  if (!cfg.apiKey) {
    return Response.json(
      { error: "AI not configured", detail: "Set LLM_API_KEY on the server." },
      { status: 501 },
    );
  }

  let body: ResearchBody;
  try {
    body = (await request.json()) as ResearchBody;
  } catch {
    return Response.json({ error: "Malformed JSON body" }, { status: 400 });
  }

  const thought = typeof body.thought === "string" ? body.thought.trim() : "";
  if (!thought) {
    return Response.json({ error: "thought is required" }, { status: 400 });
  }
  const depth = typeof body.depth === "string" && body.depth in DEPTH_HINT ? body.depth : "standard";

  let model: string;
  try {
    model = (await resolveModel(cfg)).model;
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

  try {
    const res = await fetch(chatCompletionsUrl(cfg.baseUrl), {
      method: "POST",
      headers: upstreamHeaders(cfg.apiKey),
      body: JSON.stringify({
        model,
        stream: false,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              'You are a research synthesizer. Answer with a single JSON object: ' +
              '{"summary": string, "layer": string|null}. The summary should be ' +
              `${DEPTH_HINT[depth]}. Do not include any other text.`,
          },
          { role: "user", content: thought },
        ],
      }),
      signal: request.signal,
    });

    if (!res.ok) {
      return Response.json({ error: `Upstream HTTP ${res.status}` }, { status: 502 });
    }

    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content ?? "";
    const parsed = parseResearch(content);
    return Response.json(parsed);
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === "AbortError";
    if (aborted) return new Response(null, { status: 499 });
    return Response.json({ error: "Upstream unavailable", detail: String(err) }, { status: 502 });
  } finally {
    sem.release();
  }
}

/** Parse the model's JSON reply, tolerating surrounding prose or fences. */
function parseResearch(content: string): ResearchResponse {
  const fallback: ResearchResponse = { summary: "", connections: [], layer: null };
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) {
    return { ...fallback, summary: content.trim() };
  }
  try {
    const parsed = JSON.parse(match[0]) as { summary?: unknown; layer?: unknown };
    return {
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      connections: [],
      layer: typeof parsed.layer === "string" ? parsed.layer : null,
    };
  } catch {
    return { ...fallback, summary: content.trim() };
  }
}
