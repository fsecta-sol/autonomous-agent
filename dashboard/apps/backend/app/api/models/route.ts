import { requireOperator } from "@/lib/server/auth";
import { listModels, pickModel, readUpstreamConfig } from "@/lib/server/llm-provider";

/**
 * Reports which models the configured endpoint serves, plus the model the
 * server would use by default. Powers the model picker in Settings. When the
 * endpoint can't be listed, returns an empty list (the UI falls back to a free
 * text field) rather than failing — the chat route still auto-detects on its own.
 */
export async function GET() {
  const gate = await requireOperator();
  if (gate instanceof Response) return gate;
  const cfg = readUpstreamConfig();
  if (!cfg.apiKey) {
    return Response.json({ error: "AI not configured" }, { status: 501 });
  }

  if (cfg.model) {
    return Response.json({ models: [], default: cfg.model, source: "env" });
  }

  try {
    const models = await listModels(cfg);
    return Response.json({ models, default: pickModel(models), source: "auto" });
  } catch (err) {
    return Response.json({ models: [], default: "", source: "none", detail: String(err) });
  }
}
