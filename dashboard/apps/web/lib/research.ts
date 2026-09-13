import type { GraphData } from "@dashboard/shared";

/**
 * Local concept matcher used when no AI connection is configured — the same
 * ranking the design ships: shared vocabulary between the thought and note
 * titles, boosted by node degree. With a connection configured, api.runResearch
 * goes to the LLM endpoint instead; both paths return the same shape.
 */

const STOP = new Set([
  "the", "a", "an", "of", "to", "in", "on", "at", "by", "as", "is", "are", "be", "it", "its",
  "how", "does", "do", "did", "what", "why", "when", "which", "who", "with", "under", "over", "into",
  "and", "or", "but", "for", "from", "that", "this", "these", "those", "about", "work", "works", "working",
  "hood", "really", "actually", "behind", "scene", "scenes", "want", "know", "understand", "learn",
  "yang", "dan", "atau", "itu", "ini", "mau", "tau", "tahu", "tentang", "soal", "cara", "kerja",
  "kerjanya", "gimana", "bagaimana", "buat", "jadi", "terus", "nanti", "punya", "pikiran", "seperti",
  "misal", "misalnya",
]);

function tokens(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9][a-z0-9-]+/g) || []).filter((t) => t.length >= 3 && !STOP.has(t));
}

export function conceptTitle(thought: string): string {
  let t = thought.replace(/\s+/g, " ").replace(/[?!.]+\s*$/, "").trim();
  if (t.length > 52) t = t.slice(0, 52).replace(/\s+\S*$/, "") + "…";
  return t.replace(/^[a-z]/, (c) => c.toUpperCase());
}

/** rank existing notes by shared vocabulary with the thought */
export function findConnections(graph: GraphData, thought: string, limit = 3): number[] {
  const tk = tokens(thought);
  if (!tk.length) return [];
  const scored: { i: number; score: number; deg: number }[] = [];
  graph.nodes.forEach((n, i) => {
    const titleTk = tokens(n.label);
    if (!titleTk.length) return;
    let score = 0;
    tk.forEach((a) => {
      titleTk.forEach((b) => {
        if (a === b) score += 2;
        else if (b.length >= 4 && a.includes(b)) score += 1;
        else if (a.length >= 4 && b.includes(a)) score += 1;
      });
    });
    if (score > 0) scored.push({ i, score, deg: n.degree });
  });
  scored.sort((x, y) => y.score - x.score || y.deg - x.deg);
  return scored.slice(0, limit).map((s) => s.i);
}

export function shortRestate(text: string): string {
  const clean = text.replace(/\s+/g, " ").replace(/[?!.]+$/, "").trim();
  const words = clean.split(" ");
  if (words.length <= 9) return clean;
  return words.slice(0, 9).join(" ") + "…";
}
