import { buildGraphData, type GraphData } from "@dashboard/shared";
import { listAgents } from "@/lib/db/agents";

/**
 * The two tools whose data lives in this backend (the knowledge graph and the
 * swarm roster). They are implemented here — not in the agent service — so the
 * agent reaches them over the internal HTTP endpoints in `app/internal/tools/*`.
 * Each returns the same JSON string a tool would have returned.
 */

let cachedGraph: GraphData | null = null;

/** Search the workspace knowledge graph by concept-title terms. */
export function knowledgeSearch(args: Record<string, unknown>): string {
  const query = typeof args.query === "string" ? args.query.toLowerCase().trim() : "";
  if (!query) return JSON.stringify({ matches: [] });
  const limit = typeof args.limit === "number" && args.limit > 0 ? Math.min(args.limit, 25) : 8;
  if (!cachedGraph) cachedGraph = buildGraphData();
  const terms = query.split(/\s+/).filter((t) => t.length >= 2);
  const matches = cachedGraph.nodes
    .map((n) => {
      const label = n.label.toLowerCase();
      let score = 0;
      for (const t of terms) if (label.includes(t)) score += 1;
      if (label === query) score += 3;
      return { n, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.n.degree - a.n.degree)
    .slice(0, limit)
    .map(({ n }) => ({ title: n.label, layer: n.layer, type: n.type, degree: n.degree, status: n.status }));
  return JSON.stringify({ query, matches });
}

/** The swarm roster: name, role, status, current node, task. */
export function listAgentsTool(): string {
  return JSON.stringify({
    agents: listAgents().map((a) => ({
      name: a.name,
      role: a.role,
      status: a.status,
      current: a.currentNode,
      task: a.task,
    })),
  });
}
