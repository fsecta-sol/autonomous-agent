import { agentRowToAgent, getAgentConnection, getAgentRow } from "@/lib/db/agents";
import type { Agent } from "@dashboard/shared";

/** Server-side upstream config. The API key never reaches the browser. */
export interface UpstreamConfig {
  baseUrl: string;
  apiKey: string;
  /** explicit model; empty string means "auto-detect from the endpoint" */
  model: string;
  maxConcurrency: number;
}

export function readUpstreamConfig(): UpstreamConfig {
  const max = Number.parseInt(process.env.LLM_MAX_CONCURRENCY || "8", 10);
  return {
    baseUrl: (process.env.LLM_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, ""),
    apiKey: process.env.LLM_API_KEY || "",
    // empty ⇒ resolveModel asks the endpoint which models it serves
    model: process.env.LLM_MODEL || "",
    maxConcurrency: Number.isFinite(max) && max > 0 ? max : 8,
  };
}

const MODEL_LIST_TIMEOUT_MS = 8_000;
const MODEL_LIST_TTL_MS = 5 * 60_000;

interface ModelListCache {
  models: string[];
  expires: number;
}
const modelListCache = new Map<string, ModelListCache>();

/** Short, non-reversible fingerprint so the cache key never holds a raw key. */
function fingerprint(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * List the models an OpenAI-compatible endpoint serves (`GET /models`),
 * cached briefly. Throws if the endpoint is unreachable or the call fails.
 */
export async function listModels(cfg: UpstreamConfig): Promise<string[]> {
  const key = `${cfg.baseUrl}::${fingerprint(cfg.apiKey)}`;
  const cached = modelListCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.models;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new DOMException("Model list timeout", "TimeoutError")), MODEL_LIST_TIMEOUT_MS);
  try {
    const res = await fetch(`${cfg.baseUrl}/models`, { headers: upstreamHeaders(cfg.apiKey), signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { data?: Array<{ id?: unknown }> };
    const models = (data.data ?? [])
      .map((m) => m?.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    if (models.length === 0) throw new Error("endpoint returned no models");
    modelListCache.set(key, { models, expires: Date.now() + MODEL_LIST_TTL_MS });
    return models;
  } finally {
    clearTimeout(timer);
  }
}

// ids that are clearly not chat completions
const NON_CHAT = /(embed|rerank|whisper|tts|dall-?e|moderation|image|audio|bge-|clip|stable-diffusion)/i;
// chat families we prefer, in order — a heuristic, not a capability claim
const PREFERRED = [
  /gpt-4o-mini/i,
  /gpt-4o/i,
  /gpt-4\.1/i,
  /gpt-4/i,
  /(^|\/)o[34]/i,
  /claude/i,
  /llama-3\.[13]/i,
  /qwen/i,
  /mistral|mixtral/i,
  /gemini/i,
  /deepseek/i,
  /command-r/i,
];

/** Pick a sensible chat model from an endpoint's list. */
export function pickModel(models: string[]): string {
  const candidates = models.filter((m) => !NON_CHAT.test(m));
  const pool = candidates.length ? candidates : models;
  for (const re of PREFERRED) {
    const hit = pool.find((m) => re.test(m));
    if (hit) return hit;
  }
  return pool[0];
}

export interface ResolvedModel {
  model: string;
  source: "requested" | "env" | "auto";
}

/**
 * Decide which model to call: an explicit per-request override wins, then the
 * LLM_MODEL env value, otherwise ask the endpoint and pick heuristically.
 */
export async function resolveModel(cfg: UpstreamConfig, requested?: string): Promise<ResolvedModel> {
  if (requested && requested.trim()) return { model: requested.trim(), source: "requested" };
  if (cfg.model) return { model: cfg.model, source: "env" };
  const models = await listModels(cfg);
  return { model: pickModel(models), source: "auto" };
}

export interface ChatTurn {
  role: "system" | "user" | "assistant";
  content: string;
}

const ROLES = new Set(["system", "user", "assistant"]);

/**
 * Coerce an untrusted client payload into a bounded, well-formed turn list.
 * Drops unknown roles / non-string content and keeps only the most recent
 * `maxTurns` so a long thread cannot blow up the context.
 */
export function sanitizeMessages(input: unknown, maxTurns = 40): ChatTurn[] {
  if (!Array.isArray(input)) return [];
  const turns: ChatTurn[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const role = (raw as { role?: unknown }).role;
    const content = (raw as { content?: unknown }).content;
    if (typeof role !== "string" || !ROLES.has(role)) continue;
    if (typeof content !== "string" || content.length === 0) continue;
    turns.push({ role: role as ChatTurn["role"], content });
  }
  return turns.slice(-maxTurns);
}

export function findAgent(id: string): Agent | undefined {
  const row = getAgentRow(id);
  return row ? agentRowToAgent(row) : undefined;
}

/**
 * Merge an agent's own connection over the server env. A per-agent endpoint is
 * used only when it carries its own key (an agent URL with the server key would
 * be a misconfiguration); otherwise the agent may still override just the model.
 */
export function resolveEffectiveConnection(env: UpstreamConfig, agentId: string): UpstreamConfig {
  if (!agentId) return env;
  const conn = getAgentConnection(agentId);
  if (!conn.exists) return env;
  if (conn.apiUrl && conn.apiKey) {
    return {
      ...env,
      baseUrl: conn.apiUrl.replace(/\/+$/, ""),
      apiKey: conn.apiKey,
      model: conn.model || env.model,
    };
  }
  if (conn.model) return { ...env, model: conn.model };
  return env;
}

/** A system prompt describing the agent's persona and current work. */
export function persona(agent: Agent): string {
  const node = agent.currentNode ? ` You are currently working on the knowledge-graph node "${agent.currentNode}".` : "";
  return (
    `You are ${agent.name}, a ${agent.role} agent in an autonomous research swarm. ` +
    `Current task: ${agent.task}. Focus: ${agent.focus}.${node} ` +
    `Answer concisely and helpfully, in the voice of ${agent.name}.`
  );
}

export function upstreamHeaders(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
}

export function chatCompletionsUrl(baseUrl: string): string {
  return `${baseUrl}/chat/completions`;
}
