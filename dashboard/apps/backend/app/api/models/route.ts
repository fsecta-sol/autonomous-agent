import { NextRequest } from "next/server";
import { requireOperator } from "@/lib/server/auth";
import { listModels, pickModel, readUpstreamConfig, resolveEffectiveConnection } from "@/lib/server/llm-provider";

/**
 * Reports which models the configured endpoint serves, plus the model the
 * server would use by default. Powers the model picker in Settings and in the
 * chat topbar.
 *
 * `?agentId=` resolves that agent's own endpoint + key first, so an agent with
 * its own provider lists *its* models rather than the server's. When the
 * endpoint can't be listed, returns an empty list (the UI falls back to a free
 * text field / the server default) rather than failing — the chat route still
 * auto-detects on its own.
 */
export async function GET(request: NextRequest) {
  const gate = await requireOperator();
  if (gate instanceof Response) return gate;
  const agentId = request.nextUrl.searchParams.get("agentId") || "";
  const cfg = resolveEffectiveConnection(readUpstreamConfig(), agentId);
  if (!cfg.apiKey) {
    return Response.json({ error: "AI not configured" }, { status: 501 });
  }

  // Always attempt to list, even when a default model is configured, so the
  // picker can offer alternatives instead of collapsing to the fixed value.
  try {
    const models = await listModels(cfg);
    return Response.json({ models, default: cfg.model || pickModel(models), source: cfg.model ? "env" : "auto" });
  } catch (err) {
    return Response.json({ models: [], default: cfg.model || "", source: cfg.model ? "env" : "none", detail: String(err) });
  }
}
