import type {
  KnowledgeNode,
  KnowledgeRelationship,
  Layer,
  NodeType,
  NodeTier,
  ReviewMarker,
} from "./types";
import { LAYERS, LAYER_COUNTS, POOLS, TYPES, TYPE_COUNTS } from "./concept-pools";

export const W = 1000;
export const H = 640;

const TIER_PILLAR = 16;
const TIER_PRIMARY = 9;
const TIER_SECONDARY = 4;

const REVIEW_NOTES: { title: string; status: "active" | "needs-link"; markers: ReviewMarker[] }[] = [
  { title: "Copy Trading", status: "active", markers: ["NEEDS-SOURCE", "NEEDS-WHY"] },
  { title: "Block Production", status: "active", markers: ["NEEDS-WHY", "NEEDS-EXAMPLES"] },
  { title: "Verifiable Agent Computation", status: "needs-link", markers: [] },
];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function fmtDate(day: number, moIdx: number, yr: string): string {
  return `${day < 10 ? "0" + day : day} ${MONTHS[moIdx]} ${yr}`;
}

export function seededRandom(seed: number): () => number {
  let s = seed;
  return function () {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

export function nodeLevel(degree: number): NodeTier {
  return degree >= TIER_PILLAR
    ? "pillar"
    : degree >= TIER_PRIMARY
      ? "primary"
      : degree >= TIER_SECONDARY
        ? "secondary"
        : "peripheral";
}

export function nodeRadius(degree: number): number {
  if (degree >= TIER_PILLAR) return 9 + (Math.min(degree - TIER_PILLAR, 24) / 24) * 3.5;
  if (degree >= TIER_PRIMARY) return 6.5 + ((degree - TIER_PRIMARY) / 7) * 2;
  if (degree >= TIER_SECONDARY) return 4 + ((degree - TIER_SECONDARY) / 5) * 1.6;
  return 2.4 + Math.max(0, degree - 1) * 0.5;
}

export function edgeClass(a: number, b: number, strength: number, degrees: number[]): "" | "is-strong" | "is-very-strong" {
  if (strength > 0.8) {
    return degrees[a] >= TIER_PILLAR && degrees[b] >= TIER_PILLAR ? "is-very-strong" : "is-strong";
  }
  return "";
}

export interface GraphData {
  nodes: KnowledgeNode[];
  edges: KnowledgeRelationship[];
  adj: number[][];
  /** relaxed field positions per node (hx/hy) */
  fieldPos: { x: number; y: number }[];
  /** structured (layer-column) positions per node */
  structuredPos: { x: number; y: number }[];
}

export function relationshipStrength(a: KnowledgeNode, b: KnowledgeNode): number {
  return a.layer === b.layer ? 1 : 0.58;
}

export function buildGraphData(): GraphData {
  const rand = seededRandom(42);

  function shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  }

  function pickWeighted(weights: Record<string, number>): string {
    let total = 0;
    for (const k in weights) total += weights[k];
    const r = rand() * total;
    let acc = 0;
    for (const k in weights) {
      acc += weights[k];
      if (r <= acc) return k;
    }
    return Object.keys(weights)[0];
  }

  // node labels in layer order — same sequence as the source design
  const labels: { title: string; layer: Layer }[] = [];
  LAYERS.forEach((layer) => {
    POOLS[layer].slice(0, LAYER_COUNTS[layer]).forEach((title) => {
      labels.push({ title, layer });
    });
  });

  const N = labels.length;

  const typePool: NodeType[] = [];
  TYPES.forEach((t) => {
    for (let i = 0; i < TYPE_COUNTS[t]; i++) typePool.push(t);
  });
  shuffle(typePool);

  const createdWeights: Record<string, number> = { "5": 131, "6": 56, "7": 59 };
  const updatedWeights: Record<string, number> = { "7": 106, "5": 84, "6": 56 };

  const nodes: KnowledgeNode[] = labels.map((entry, i) => {
    let updated = fmtDate(1 + Math.floor(rand() * 28), +pickWeighted(updatedWeights), "26");
    let recent = false;
    const created = fmtDate(1 + Math.floor(rand() * 28), +pickWeighted(createdWeights), "26");
    const sources = 1 + Math.floor(rand() * 3);
    if (rand() < 0.08) {
      updated = fmtDate(23 + Math.floor(rand() * 13), 8, "26");
      recent = true;
    }
    return {
      id: `n${i}`,
      label: entry.title,
      type: typePool[i],
      layer: entry.layer,
      degree: 0,
      tier: "peripheral",
      importance: 0,
      status: "active",
      markers: [],
      created,
      updated,
      recent,
      sources,
      createdAt: created,
      linksOut: 0,
      linksIn: 0,
    };
  });

  // pin the notes referenced in the activity feed + chat
  ["MEV", "Bonding Curve", "Memecoin", "Copy Trading"].forEach((t) => {
    const n = nodes.find((x) => x.label === t);
    if (n) {
      n.updated = "05 Sep 26";
      n.recent = true;
    }
  });

  REVIEW_NOTES.forEach((r) => {
    const n = nodes.find((x) => x.label === r.title);
    if (n) {
      n.status = r.status;
      n.markers = [...r.markers];
      if (r.markers.includes("NEEDS-SOURCE")) n.sources = 0;
    }
  });

  // edges — preferential attachment on a shared-layer prior
  const edges: KnowledgeRelationship[] = [];
  const adj: number[][] = nodes.map(() => []);
  const degrees: number[] = nodes.map(() => 0);

  function addEdge(a: number, b: number) {
    const strength = relationshipStrength(nodes[a], nodes[b]);
    edges.push({
      id: `e${a}-${b}`,
      source: a,
      target: b,
      type: "related",
      strength,
      tier: "",
    });
    adj[a].push(b);
    adj[b].push(a);
    degrees[a]++;
    degrees[b]++;
  }

  addEdge(0, 1);
  for (let i = 2; i < N; i++) {
    const r0 = rand();
    const m = i < 4 ? 1 : r0 < 0.12 ? 6 : r0 < 0.3 ? 4 : r0 < 0.6 ? 3 : 2;
    const targets = new Set<number>();
    let tries = 0;
    while (targets.size < Math.min(m, i) && tries < 60) {
      tries++;
      const candidate = edges.length ? edges[Math.floor(rand() * edges.length)] : { source: 0, target: 0 };
      const pick = rand() < 0.5 ? candidate.source : candidate.target;
      if (pick !== i) targets.add(pick);
    }
    targets.forEach((t) => addEdge(i, t));
  }

  // MEV is the vault's best-connected mechanism note
  const mevIdx = nodes.findIndex((n) => n.label === "MEV");
  while (adj[mevIdx].length < 19) {
    const j = Math.floor(rand() * (N - 1)) + 1;
    if (j !== mevIdx && !adj[mevIdx].includes(j)) addEdge(mevIdx, j);
  }

  nodes.forEach((n, i) => {
    n.degree = adj[i].length;
    n.tier = nodeLevel(n.degree);
    n.importance = n.degree;
    n.linksOut = Math.ceil(n.degree / 2);
    n.linksIn = Math.floor(n.degree / 2);
  });

  edges.forEach((e) => {
    e.tier = edgeClass(e.source, e.target, e.strength, degrees);
  });

  // semantic seed coordinates + bounded relaxation → the field layout
  function hash01(str: string, salt: number): number {
    let h = 2166136261 ^ salt;
    for (let i = 0; i < str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 16777619);
    }
    return (h >>> 0) / 4294967295;
  }

  const fieldPos = nodes.map((n) => {
    const ang = hash01(n.label, 13) * Math.PI * 2;
    const rad = 70 + hash01(n.label, 29) * 250;
    return { x: W / 2 + Math.cos(ang) * rad, y: H / 2 + Math.sin(ang) * rad * 0.72 };
  });
  const seedPos = fieldPos.map((p) => ({ ...p }));

  const REDUCED_ITERS = 34;
  const GRID = 44;
  const ITERS = REDUCED_ITERS * 5; // headless: full-quality relaxation (180 in the design)
  for (let it = 0; it < ITERS; it++) {
    const bucket: Record<string, number[]> = {};
    for (let i = 0; i < N; i++) {
      const bk = Math.floor(fieldPos[i].x / GRID) + ":" + Math.floor(fieldPos[i].y / GRID);
      (bucket[bk] || (bucket[bk] = [])).push(i);
    }
    for (let a = 0; a < N; a++) {
      const na = fieldPos[a];
      na.x += (seedPos[a].x - na.x) * 0.008;
      na.y += (seedPos[a].y - na.y) * 0.008;
      const gx = Math.floor(na.x / GRID);
      const gy = Math.floor(na.y / GRID);
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          const list = bucket[gx + ox + ":" + (gy + oy)];
          if (!list) continue;
          for (const b of list) {
            if (b <= a) continue;
            const nb = fieldPos[b];
            const dx = na.x - nb.x;
            const dy = na.y - nb.y;
            const min = nodeRadius(nodes[a].degree) + nodeRadius(nodes[b].degree) + 6.5;
            const d2 = dx * dx + dy * dy;
            if (d2 < min * min && d2 > 0.02) {
              const d = Math.sqrt(d2);
              const push = ((min - d) / d) * 0.5;
              na.x += dx * push;
              na.y += dy * push;
              nb.x -= dx * push;
              nb.y -= dy * push;
            }
          }
        }
      }
    }
    edges.forEach((e) => {
      const a = fieldPos[e.source];
      const b = fieldPos[e.target];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.max(1, Math.hypot(dx, dy));
      const ideal = e.strength > 0.8 ? 80 : 122;
      const pull = ((d - ideal) / d) * 0.009 * e.strength;
      a.x += dx * pull;
      a.y += dy * pull;
      b.x -= dx * pull;
      b.y -= dy * pull;
    });
    for (let c = 0; c < N; c++) {
      fieldPos[c].x = Math.max(26, Math.min(W - 26, fieldPos[c].x));
      fieldPos[c].y = Math.max(22, Math.min(H - 20, fieldPos[c].y));
    }
  }

  // structured view: layer-first columns derived from the same graph
  const byLayer: Record<string, number[]> = {};
  LAYERS.forEach((layer) => {
    byLayer[layer] = [];
  });
  nodes.forEach((n, i) => byLayer[n.layer].push(i));
  const structuredPos: { x: number; y: number }[] = new Array(N);
  LAYERS.forEach((layer, layerIndex) => {
    const list = byLayer[layer];
    list.sort((a, b) => nodes[b].degree - nodes[a].degree || nodes[a].label.localeCompare(nodes[b].label));
    const columns = Math.max(1, Math.ceil(Math.sqrt(list.length / 1.5)));
    list.forEach((index, position) => {
      const col = position % columns;
      const row = Math.floor(position / columns);
      structuredPos[index] = {
        x: 90 + (layerIndex * (W - 180)) / (LAYERS.length - 1) + (col - (columns - 1) / 2) * 24,
        y: 64 + row * 31 + (col % 2) * 8,
      };
    });
  });

  return { nodes, edges, adj, fieldPos, structuredPos };
}
