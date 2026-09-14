import type { KnowledgeNode, Layer, NodeType } from "@dashboard/shared";
import type { GraphData } from "@dashboard/shared";

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export interface MarkdownOptions {
  /** render a `[[wikilink]]`; receives the already-escaped label. */
  wiki?: (escapedLabel: string) => string;
  /** allow raw `<div>`/`<table>` passthrough. Defaults OFF; opt in only for
   *  app-authored content you trust, never for LLM or user text. */
  allowRawHtml?: boolean;
}

/**
 * Tiny markdown → html renderer, safe subset for the vault's own files:
 * escape-first, then a narrow inline allowlist (code, wikilinks, bold).
 * Raw HTML passthrough is off unless the caller explicitly opts in.
 */
export function renderMarkdown(src: string, opts: MarkdownOptions = {}): string {
  const allowRawHtml = opts.allowRawHtml === true;
  const wiki = opts.wiki ?? ((label: string) => `<span class="rd-wiki">${label}</span>`);
  const lines = src.split("\n");
  let html = "";
  let i = 0;
  let listType: string | null = null;
  const closeList = () => {
    if (listType) {
      html += `</${listType}>\n`;
      listType = null;
    }
  };
  let inFence = false;
  let fenceBuf: string[] = [];
  const flushFence = () => {
    if (inFence) {
      html += `<pre><code>${esc(fenceBuf.join("\n"))}</code></pre>\n`;
      fenceBuf = [];
      inFence = false;
    }
  };
  const inline = (t: string): string => {
    let s = esc(t);
    s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
    s = s.replace(/\[\[(.+?)\]\]/g, (_full, label: string) => wiki(label));
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    // italic runs after bold so `**x**` is already consumed; the content must
    // be space-tight (`*x*` not `5 * 3`) so a stray asterisk can't italicize
    s = s.replace(/\*([^\s*](?:[^*]*[^\s*])?)\*/g, "<em>$1</em>");
    return s;
  };
  // allow a small allowlist of hand-authored analysis components inside markdown
  const rawWiki = (t: string): string => {
    if (!allowRawHtml || !/^<(div|table)/.test(t)) return esc(t);
    return t.replace(/\[\[(.+?)\]\]/g, (_full, label: string) => wiki(label));
  };

  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trim();
    if (inFence) {
      if (line.startsWith("```")) flushFence();
      else fenceBuf.push(raw);
      i++;
      continue;
    }
    if (line.startsWith("```")) {
      closeList();
      inFence = true;
      i++;
      continue;
    }
    if (!line) {
      closeList();
      html += "\n";
      i++;
      continue;
    }
    if (line.startsWith("<div")) {
      closeList();
      html += rawWiki(line) + "\n";
      i++;
      continue;
    }
    if (line.startsWith("|") && lines[i + 1] && lines[i + 1].trim().startsWith("|") && /^\|[\s:|-]+\|$/.test(lines[i + 1].trim())) {
      const headerCells = line.slice(1, -1).split("|").map((c) => c.trim());
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        rows.push(lines[i].slice(1, -1).split("|").map((c) => c.trim()));
        i++;
      }
      html +=
        "<table><thead><tr>" +
        headerCells.map((c) => `<th>${inline(c)}</th>`).join("") +
        "</tr></thead><tbody>";
      rows.forEach((r) => {
        html += `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`;
      });
      html += "</tbody></table>\n";
      continue;
    }
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^(#{1,3})\s+(.*)$/))) {
      closeList();
      const lv = m[1].length;
      html += `${lv === 1 ? "<h1>" : lv === 2 ? "<h2>" : "<h3>"}${inline(m[2])}</h${lv}>\n`;
      i++;
      continue;
    }
    if ((m = line.match(/^>\s?(.*)$/))) {
      closeList();
      const q: string[] = [];
      while (i < lines.length && (m = lines[i].trim().match(/^>\s?(.*)$/))) {
        q.push(m[1]);
        i++;
      }
      html += `<blockquote>${q.map((t) => (t ? inline(t) : "<br>")).join("\n")}</blockquote>\n`;
      continue;
    }
    if ((m = line.match(/^[-*]\s+(.*)$/))) {
      if (listType !== "ul") {
        closeList();
        html += "<ul>";
        listType = "ul";
      }
      html += `<li>${inline(m[1])}</li>\n`;
      i++;
      continue;
    }
    if ((m = line.match(/^\d+\.\s+(.*)$/))) {
      if (listType !== "ol") {
        closeList();
        html += "<ol>";
        listType = "ol";
      }
      html += `<li>${inline(m[1])}</li>\n`;
      i++;
      continue;
    }
    closeList();
    const para = [raw.trim()];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].trim().startsWith("```") &&
      !/^#{1,3}\s/.test(lines[i].trim()) &&
      !/^>\s?/.test(lines[i].trim()) &&
      !lines[i].trim().startsWith("|") &&
      !lines[i].trim().startsWith("<div") &&
      !/^[-*]\s+/.test(lines[i].trim()) &&
      !/^\d+\.\s+/.test(lines[i].trim())
    ) {
      para.push(lines[i].trim());
      i++;
    }
    html += `<p>${inline(para.join(" "))}</p>\n`;
  }
  closeList();
  flushFence();
  return html;
}

const TYPE_PREVIEW: Record<NodeType, (t: string, l: string) => string> = {
  system: (t, l) => `${t} is a system-level mechanism — one of the moving parts that makes ${l} protocols function in practice, not just in theory.`,
  fundamental: (t, l) => `${t} is a foundational primitive most ${l} designs build on without restating.`,
  economy: (t, l) => `${t} shapes incentives inside ${l}: who gets paid, who bears risk, and when.`,
  programming: (t, l) => `${t} is an implementation detail with outsized consequences for ${l} correctness.`,
  concept: (t, l) => `${t} is a recurring idea across ${l} — worth its own note because it keeps resurfacing.`,
  "cross-cutting": (t, l) => `${t} cuts across layers; it shows up wherever ${l} intersects with the rest of the graph.`,
  trading: (t, l) => `${t} is a trading-side pattern — how ${l} mechanics get expressed in market behavior.`,
  blockchain: (t, l) => `${t} is chain-level plumbing underneath ${l}.`,
};

const LAYER_ORDER: Record<Layer, number> = {
  cryptography: 0,
  foundations: 1,
  platforms: 2,
  applications: 3,
  market: 4,
  "cross-cutting": 2,
};

export interface LinkGroups {
  builds: string[];
  enables: string[];
  related: string[];
}

/** strongest ties per node — the only relationships hover/inspector reveal */
export function computeStrongLinks(
  adj: number[][],
  edges: GraphData["edges"],
  nodes: GraphData["nodes"],
): number[][] {
  const strengthByEnds = new Map<string, number>();
  edges.forEach((e) => {
    const k = Math.min(e.source, e.target) + ":" + Math.max(e.source, e.target);
    strengthByEnds.set(k, e.strength);
  });
  return adj.map((list, self) =>
    [...list]
      .sort((a, b) => {
        const sa = (strengthByEnds.get(Math.min(self, a) + ":" + Math.max(self, a)) || 0) + nodes[a].degree * 0.012;
        const sb = (strengthByEnds.get(Math.min(self, b) + ":" + Math.max(self, b)) || 0) + nodes[b].degree * 0.012;
        return sb - sa;
      })
      .slice(0, 6),
  );
}

export function linkGroups(graph: GraphData, i: number): LinkGroups {
  const { nodes, adj } = graph;
  const n = nodes[i];
  const nb = [...adj[i]];
  const builds: number[] = [];
  const enables: number[] = [];
  nb.forEach((j) => (LAYER_ORDER[nodes[j].layer] < LAYER_ORDER[n.layer] ? builds : enables).push(j));
  if (!builds.length && enables.length > 1) {
    const half = enables.splice(0, Math.ceil(enables.length / 2));
    builds.push(...half);
  }
  builds.splice(3);
  enables.splice(3);
  const shown = new Set<number>([i]);
  [...builds, ...enables].forEach((j) => shown.add(j));
  const sameLayer = nodes
    .map((x, idx) => (x.layer === n.layer && !shown.has(idx) ? idx : -1))
    .filter((x) => x >= 0);
  const related: number[] = [];
  const step = Math.max(1, Math.floor(sameLayer.length / 2));
  for (let k = 0; k < sameLayer.length && related.length < 2; k += step) related.push(sameLayer[k]);

  const titles = (arr: number[]) => arr.map((j) => nodes[j].label);
  return { builds: titles(builds), enables: titles(enables), related: titles(related) };
}

export function whyPreview(n: KnowledgeNode): string {
  return (
    `${n.label} exists because ${n.layer} needs a predictable answer to this problem; it works by making the trade-off explicit ` +
    `rather than leaving it implicit in ${n.type === "economy" ? "the incentive structure" : n.type === "programming" ? "the implementation" : "protocol rules"}. ` +
    `Remove it and the same cost reappears somewhere less visible.`
  );
}

export function noteMarkdown(graph: GraphData, n: KnowledgeNode): string {
  const idx = graph.nodes.findIndex((x) => x.id === n.id);
  const g = linkGroups(graph, idx);
  const list = (a: string[]) => (a.length ? a.map((t) => `- [[${t}]]`).join("\n") : "- —");
  return (
    `# ${n.label}\n\n` +
    `| field | value |\n| --- | --- |\n` +
    `| concept | ${n.label} |\n| type | ${n.type} |\n| layer | ${n.layer} |\n` +
    `| created | ${n.created} |\n| updated | ${n.updated} |\n| sources | ${n.sources} |\n| status | ${n.status} |\n\n` +
    `## What\n\n${TYPE_PREVIEW[n.type](n.label, n.layer)}\n\n` +
    `## Why it exists / why it works\n\n${whyPreview(n)}\n\n` +
    `## Builds on\n\n${list(g.builds)}\n\n` +
    `## Enables\n\n${list(g.enables)}\n\n` +
    `## Related (same layer)\n\n${list(g.related)}\n\n` +
    (n.markers.length
      ? `## Needs review\n\n${n.markers.map((m) => `- \`[${m}]\` — raised by \`scan-curated-sources\``).join("\n")}\n`
      : n.status !== "active"
        ? `## Needs review\n\n- status \`${n.status}\`\n`
        : "")
  );
}
