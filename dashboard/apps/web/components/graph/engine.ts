import type { GraphData } from "@dashboard/shared";
import type { KnowledgeNode, Agent, Layer, NodeType, ReviewMarker, GraphMode } from "@dashboard/shared";
import { computeStrongLinks } from "@/lib/markdown";

/** runtime node: the typed data plus the simulation's mutable fields */
export interface RuntimeNode extends KnowledgeNode {
  r: number;
  level: "pillar" | "primary" | "secondary" | "peripheral";
  strongLinks: number[];
  hx: number;
  hy: number;
  seedX: number;
  seedY: number;
  fieldX: number;
  fieldY: number;
  structuredX: number;
  structuredY: number;
  x: number;
  y: number;
  ox: number;
  oy: number;
  vx: number;
  vy: number;
  phase: number;
  activity: number;
  activeNew: number;
  enter: number;
  enterAt: number;
  _dragX: number;
  _dragY: number;
}

export interface RuntimeEdge {
  id: string;
  a: number;
  b: number;
  strength: number;
  tier: "" | "is-strong" | "is-very-strong";
  _reveal: number;
  _flow: number;
}

export interface GraphSnapshot {
  nodeCount: number;
  edgeCount: number;
  visibleCount: number;
  layers: Record<string, number>;
  types: Record<string, number>;
  layersActive: number;
  typesActive: number;
}

export interface HoverInfo {
  index: number;
  label: string;
  type: NodeType;
  strongTies: number;
  screenX: number;
  screenY: number;
}

export interface EngineCallbacks {
  onHover: (info: HoverInfo | null) => void;
  onSelect: (index: number | null) => void;
  onPhase: (labels: string[], current: number) => void;
  onSnapshot: (snap: GraphSnapshot) => void;
}

const AGENT_TOKEN: Record<string, string> = {
  Kai: "--l-cryptography",
  Vale: "--l-foundations",
  Tally: "--l-platforms",
  Moss: "--l-applications",
  Wick: "--l-market",
  Echo: "--l-cross-cutting",
};

function hash01(str: string, salt: number): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967295;
}

interface AgentEnt {
  idx: number;
  px: number;
  py: number;
  trail: [number, number][];
  orbit: number;
}

export class GraphEngine {
  private canvas: HTMLCanvasElement;
  private field: HTMLElement;
  private cb: EngineCallbacks;

  nodes: RuntimeNode[] = [];
  edges: RuntimeEdge[] = [];
  adj: number[][] = [];
  private N = 0;

  private REDUCED: boolean;
  private EASE: string;

  private cssW = 1;
  private cssH = 1;
  private DPR = 1;
  private sized = false;

  private cam = { x: 500, y: 320, zoom: 1, tx: 500, ty: 320, tzoom: 1 };

  private currentLens: GraphMode = "field";
  private layoutMix = 0;
  private layoutTarget = 0;

  private hoveredIdx: number | null = null;
  private selectedIdx: number | null = null;

  private flashes: { x: number; y: number; r0: number; r1: number; t0: number; dur: number }[] = [];
  private flashEdges: { a: number; b: number; t0: number; dur: number }[] = [];

  private agentEnts: Record<string, AgentEnt> = {};
  private agentsFn: () => Agent[] = () => [];
  private liveFn: () => boolean = () => true;
  /** agents mid-ingestion — transient engine state, not part of the domain model */
  private ingesting = new Set<string>();

  private activeLayers = new Set<string>();
  private activeTypes = new Set<string>();
  private layerCounts: Record<string, number> = {};
  private typeCounts: Record<string, number> = {};

  private draggingNode: RuntimeNode | null = null;
  private ptr = { down: false, moved: false, sx: 0, sy: 0, mode: null as null | "pan" | "drag", camX: 0, camY: 0 };

  private colors: Record<string, string> = {};
  private raf = 0;
  private last = 0;
  private ro: ResizeObserver | null = null;
  private mo: MutationObserver | null = null;
  private primaryCycle: number[] = [];
  private cyclePos = -1;
  private destroyed = false;

  private bound = {
    move: (e: PointerEvent) => this.onPointerMove(e),
    down: (e: PointerEvent) => this.onPointerDown(e),
    up: (e: PointerEvent) => this.onPointerUp(e),
    cancel: () => this.endPointer(),
    leave: () => {
      if (!this.ptr.down) this.setHover(null);
    },
    wheel: (e: WheelEvent) => this.onWheel(e),
    key: (e: KeyboardEvent) => this.onKey(e),
  };

  constructor(canvas: HTMLCanvasElement, field: HTMLElement, private graph: GraphData, cb: EngineCallbacks) {
    this.canvas = canvas;
    this.field = field;
    this.cb = cb;
    this.REDUCED =
      typeof window !== "undefined" && !!window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.EASE =
      getComputedStyle(document.documentElement).getPropertyValue("--ease").trim() || "cubic-bezier(.2,.7,.2,1)";
    this.attachCtx();
    this.build();
    this.refreshColors();
  }

  private build() {
    const { nodes, edges, adj, fieldPos, structuredPos } = this.graph;
    const strongLinks = computeStrongLinks(adj, edges, nodes);

    const lc: Record<string, number> = {};
    const tc: Record<string, number> = {};
    this.nodes = nodes.map((n, i) => {
      lc[n.layer] = (lc[n.layer] || 0) + 1;
      tc[n.type] = (tc[n.type] || 0) + 1;
      const f = fieldPos[i];
      const s = structuredPos[i];
      const phase = hash01(n.label, 91) * Math.PI * 2;
      return {
        ...n,
        r: nodeRadiusFor(n.degree),
        level: levelFor(n.degree),
        strongLinks: strongLinks[i],
        hx: f.x,
        hy: f.y,
        seedX: f.x,
        seedY: f.y,
        fieldX: f.x,
        fieldY: f.y,
        structuredX: s.x,
        structuredY: s.y,
        x: f.x,
        y: f.y,
        ox: 0,
        oy: 0,
        vx: 0,
        vy: 0,
        phase,
        activity: 0,
        activeNew: 0,
        enter: this.REDUCED ? 1 : 0,
        enterAt: 0,
        _dragX: f.x,
        _dragY: f.y,
      };
    });
    this.layerCounts = lc;
    this.typeCounts = tc;
    this.N = this.nodes.length;
    this.adj = adj.map((row) => [...row]);
    this.edges = edges.map((e) => ({
      id: e.id,
      a: e.source,
      b: e.target,
      strength: e.strength,
      tier: e.tier,
      _reveal: 0,
      _flow: 0,
    }));

    this.primaryCycle = this.nodes
      .map((n, i) => ({ i, n }))
      .filter((x) => x.n.level === "pillar" || x.n.level === "primary")
      .sort((a, b) => b.n.degree - a.n.degree)
      .map((x) => x.i);
  }

  setAgentsSource(fn: () => Agent[]) {
    this.agentsFn = fn;
  }
  setLiveSource(fn: () => boolean) {
    this.liveFn = fn;
  }

  mount() {
    if (this.destroyed) return;
    this.resize(true);
    this.ro = new ResizeObserver(() => this.resize(false));
    this.ro.observe(this.field);
    window.addEventListener("resize", this.onResize);
    this.mo = new MutationObserver(() => this.refreshColors());
    this.mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });

    const c = this.canvas;
    c.addEventListener("pointermove", this.bound.move);
    c.addEventListener("pointerdown", this.bound.down);
    c.addEventListener("pointerup", this.bound.up);
    c.addEventListener("pointercancel", this.bound.cancel);
    c.addEventListener("pointerleave", this.bound.leave);
    c.addEventListener("wheel", this.bound.wheel, { passive: false });
    c.addEventListener("keydown", this.bound.key);

    // stagger the entrance from the moment the field first has real size
    if (!this.REDUCED) {
      const t0 = performance.now();
      this.nodes.forEach((n, i) => {
        n.enter = 0;
        n.enterAt = t0 + Math.min(i, 110) * 9;
      });
    }

    this.last = performance.now();
    const loop = (now: number) => {
      if (this.destroyed) return;
      this.frame(now);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private onResize = () => this.resize(false);

  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    this.ro?.disconnect();
    this.mo?.disconnect();
    window.removeEventListener("resize", this.onResize);
    const c = this.canvas;
    c.removeEventListener("pointermove", this.bound.move);
    c.removeEventListener("pointerdown", this.bound.down);
    c.removeEventListener("pointerup", this.bound.up);
    c.removeEventListener("pointercancel", this.bound.cancel);
    c.removeEventListener("pointerleave", this.bound.leave);
    c.removeEventListener("wheel", this.bound.wheel);
    c.removeEventListener("keydown", this.bound.key);
  }

  /* ── colours (theme-aware) ──────────────────────────────── */
  private refreshColors() {
    const cs = getComputedStyle(document.documentElement);
    const keys = [
      "--ink", "--bg", "--surface", "--muted", "--hairline", "--accent", "--label", "--l-warn",
      "--l-cryptography", "--l-foundations", "--l-platforms", "--l-applications", "--l-market", "--l-cross-cutting",
    ];
    const next: Record<string, string> = {};
    keys.forEach((v) => {
      next[v] = cs.getPropertyValue(v).trim() || "#888";
    });
    this.colors = next;
  }
  private col(k: string): string {
    return this.colors[k] || "#888";
  }

  /* ── sizing + camera ────────────────────────────────────── */
  private resize(first: boolean) {
    const rect = this.field.getBoundingClientRect();
    this.cssW = Math.max(1, Math.round(rect.width));
    this.cssH = Math.max(1, Math.round(rect.height));
    this.DPR = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = this.cssW * this.DPR;
    this.canvas.height = this.cssH * this.DPR;
    this.canvas.style.width = this.cssW + "px";
    this.canvas.style.height = this.cssH + "px";
    if (!this.sized && this.cssW > 10 && this.cssH > 10) {
      this.sized = true;
      this.fitView(true);
      if (!this.REDUCED && !first) {
        const t0 = performance.now();
        this.nodes.forEach((n, i) => {
          n.enter = 0;
          n.enterAt = t0 + Math.min(i, 110) * 9;
        });
      }
    } else if (this.sized) {
      this.cam.tzoom = Math.max(this.baseZoom() * 0.55, Math.min(this.baseZoom() * 7, this.cam.tzoom));
    }
  }
  private baseZoom() {
    return Math.max(0.2, Math.min(this.cssW / (1000 + 140), this.cssH / (640 + 140)));
  }
  private zr() {
    return this.cam.zoom / this.baseZoom();
  }
  private worldToScreen(wx: number, wy: number): [number, number] {
    return [(wx - this.cam.x) * this.cam.zoom + this.cssW / 2, (wy - this.cam.y) * this.cam.zoom + this.cssH / 2];
  }
  private screenToWorld(sx: number, sy: number): [number, number] {
    return [(sx - this.cssW / 2) / this.cam.zoom + this.cam.x, (sy - this.cssH / 2) / this.cam.zoom + this.cam.y];
  }
  fitView(instant: boolean) {
    this.cam.tx = 500;
    this.cam.ty = 320;
    this.cam.tzoom = this.baseZoom() * 1.02;
    if (instant) {
      this.cam.x = this.cam.tx;
      this.cam.y = this.cam.ty;
      this.cam.zoom = this.cam.tzoom;
    }
  }

  /* ── public API used by React chrome ────────────────────── */
  setMode(mode: GraphMode) {
    this.currentLens = mode === "structured" ? "structured" : "field";
    this.layoutTarget = this.currentLens === "structured" ? 1 : 0;
  }
  zoomBy(factor: number) {
    this.cam.tzoom = Math.max(this.baseZoom() * 0.55, Math.min(this.baseZoom() * 7, this.cam.zoom * factor));
  }
  fit() {
    this.fitView(false);
  }
  focusNode(idx: number) {
    const n = this.nodes[idx];
    if (!n) return;
    this.cam.tx = n.x;
    this.cam.ty = n.y;
    this.cam.tzoom = Math.max(this.cam.zoom, this.baseZoom() * 2.0);
  }
  focusCluster(indices: number[]) {
    if (!indices || !indices.length) return;
    if (indices.length === 1) return this.focusNode(indices[0]);
    let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    indices.forEach((i) => {
      const n = this.nodes[i];
      if (!n) return;
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x);
      maxY = Math.max(maxY, n.y);
    });
    this.cam.tx = (minX + maxX) / 2;
    this.cam.ty = (minY + maxY) / 2;
    const w = Math.max(140, maxX - minX + 140);
    const h = Math.max(110, maxY - minY + 110);
    this.cam.tzoom = Math.max(this.baseZoom() * 0.7, Math.min(this.baseZoom() * 3.2, Math.min(this.cssW / w, this.cssH / h)));
  }
  select(idx: number) {
    this.selectedIdx = idx;
    this.focusNode(idx);
    this.cb.onSelect(idx);
  }
  selectAndCenter(idx: number) {
    this.select(idx);
  }
  closeInspector() {
    this.selectedIdx = null;
    this.cb.onSelect(null);
  }
  pulse(idx: number) {
    this.pulseNode(idx);
  }
  indexOfTitle(title: string): number {
    for (let i = 0; i < this.nodes.length; i++) if (this.nodes[i].label === title) return i;
    return -1;
  }

  /* ── filters ────────────────────────────────────────────── */
  setFilters(layers: Set<string>, types: Set<string>) {
    this.activeLayers = layers;
    this.activeTypes = types;
    this.emitSnapshot();
  }
  private filterActive() {
    return this.activeLayers.size > 0 || this.activeTypes.size > 0;
  }
  private passesFilter(i: number) {
    const n = this.nodes[i];
    if (this.activeLayers.size && !this.activeLayers.has(n.layer)) return false;
    if (this.activeTypes.size && !this.activeTypes.has(n.type)) return false;
    return true;
  }
  private emitSnapshot() {
    const visible = this.filterActive() ? this.nodes.filter((_, i) => this.passesFilter(i)).length : this.N;
    this.cb.onSnapshot({
      nodeCount: this.N,
      edgeCount: this.edges.length,
      visibleCount: visible,
      layers: this.layerCounts,
      types: this.typeCounts,
      layersActive: this.activeLayers.size,
      typesActive: this.activeTypes.size,
    });
  }
  getSnapshot(): GraphSnapshot {
    return {
      nodeCount: this.N,
      edgeCount: this.edges.length,
      visibleCount: this.N,
      layers: this.layerCounts,
      types: this.typeCounts,
      layersActive: this.activeLayers.size,
      typesActive: this.activeTypes.size,
    };
  }
  getLayerCounts() {
    return this.layerCounts;
  }
  getTypeCounts() {
    return this.typeCounts;
  }

  /* ── transient signal (agent touches a concept) ─────────── */
  signalGraphActivity(title: string) {
    if (!this.liveFn()) return;
    const idx = this.indexOfTitle(title);
    if (idx < 0) return;
    const n = this.nodes[idx];
    n.activity = Math.min(1, n.activity + 0.85);
    n.activeNew = performance.now();
    this.pulseNode(idx);
    if (!this.REDUCED) this.fieldImpulse(n.x, n.y, 2.2, 130);
    const strong = n.strongLinks.length ? n.strongLinks : (this.adj[idx] || []).slice(0, 5);
    strong.forEach((j) => {
      const e = this.edgeByEnds(idx, j);
      if (e) {
        e._reveal = performance.now() + 1300;
        e._flow = performance.now() + 1300;
      }
      if (this.nodes[j]) this.nodes[j].activity = Math.min(1, this.nodes[j].activity + 0.3);
    });
  }
  private edgeByEnds(a: number, b: number): RuntimeEdge | undefined {
    return this.edges.find((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a));
  }

  /** Append a researched concept into the live graph; returns the new index. */
  appendToGraph(title: string, conn: number[]): number {
    let cx = 0, cy = 0;
    conn.forEach((j) => {
      cx += this.nodes[j].x;
      cy += this.nodes[j].y;
    });
    cx = conn.length ? cx / conn.length : 500;
    cy = conn.length ? cy / conn.length : 320;
    cx += (Math.random() - 0.5) * 56;
    cy += (Math.random() - 0.5) * 56;
    cx = Math.max(30, Math.min(970, cx));
    cy = Math.max(26, Math.min(616, cy));

    const idx = this.nodes.length;
    const layer: Layer = conn.length ? this.nodes[conn[0]].layer : "cross-cutting";
    const n: RuntimeNode = {
      id: `n${idx}`,
      label: title,
      layer,
      type: "concept",
      degree: conn.length,
      tier: levelFor(conn.length),
      level: levelFor(conn.length),
      importance: conn.length,
      status: "active",
      markers: [] as ReviewMarker[],
      created: "07 Sep 26",
      updated: "07 Sep 26",
      createdAt: "07 Sep 26",
      recent: true,
      sources: Math.max(1, conn.length),
      linksOut: Math.ceil(conn.length / 2),
      linksIn: Math.floor(conn.length / 2),
      strongLinks: [],
      r: nodeRadiusFor(conn.length),
      hx: cx,
      hy: cy,
      seedX: cx,
      seedY: cy,
      fieldX: cx,
      fieldY: cy,
      structuredX: cx,
      structuredY: cy,
      x: cx,
      y: cy,
      ox: 0,
      oy: 0,
      vx: 0,
      vy: 0,
      phase: Math.random() * Math.PI * 2,
      activity: 1,
      activeNew: performance.now(),
      enter: 0,
      enterAt: performance.now(),
      _dragX: cx,
      _dragY: cy,
    };
    this.nodes.push(n);
    this.adj.push([]);
    this.N = this.nodes.length;

    conn.forEach((j) => {
      const strength = this.nodes[j].layer === layer ? 1 : 0.58;
      const e: RuntimeEdge = {
        id: `e${idx}-${j}`,
        a: idx,
        b: j,
        strength,
        tier: this.tierFor(idx, j, strength),
        _reveal: performance.now() + 1600,
        _flow: performance.now() + 1600,
      };
      this.edges.push(e);
      this.adj[idx].push(j);
      this.adj[j].push(idx);
      this.nodes[j].degree = this.adj[j].length;
      this.nodes[j].level = levelFor(this.nodes[j].degree);
      this.nodes[j].r = nodeRadiusFor(this.nodes[j].degree);
      this.nodes[j].activity = Math.min(1, this.nodes[j].activity + 0.5);
    });
    this.recomputeStrongLinks();

    if (!this.REDUCED) this.fieldImpulse(cx, cy, 3.2, 160);
    const settleUntil = performance.now() + 1500;
    const settle = () => {
      if (performance.now() > settleUntil || this.destroyed) return;
      if (conn.length) {
        let gx = 0, gy = 0;
        conn.forEach((j) => {
          gx += this.nodes[j].x;
          gy += this.nodes[j].y;
        });
        n.hx += (gx / conn.length - n.hx) * 0.04;
        n.hy += (gy / conn.length - n.hy) * 0.04;
      }
      requestAnimationFrame(settle);
    };
    requestAnimationFrame(settle);
    setTimeout(() => {
      n.activeNew = 0;
    }, 4200);

    this.emitSnapshot();
    return idx;
  }

  private tierFor(a: number, b: number, strength: number): "" | "is-strong" | "is-very-strong" {
    if (strength > 0.8) {
      return this.nodes[a].degree >= 16 && this.nodes[b].degree >= 16 ? "is-very-strong" : "is-strong";
    }
    return "";
  }
  private recomputeStrongLinks() {
    const next = computeStrongLinks(this.adj, this.edges as unknown as GraphData["edges"], this.nodes);
    this.nodes.forEach((n, i) => {
      n.strongLinks = next[i];
    });
  }

  /** Five-beat ingestion choreography: Agent → Discovery → Knowledge → Relationships → Integration. */
  runIngestChoreography(title: string, conn: number[], agentName: string, done?: (idx: number) => void) {
    const labels = ["Agent", "Discovery", "Knowledge", "Relationships", "Integration"];
    this.cb.onPhase(labels, 0);
    const agent = this.agentsFn().find((a) => a.name === agentName);
    const step = (i: number) => {
      this.cb.onPhase(labels, i);
      if (i === 0 && agent) this.ingesting.add(agent.name);
      if (i === 1 && agent) {
        conn.forEach((j) => {
          if (this.nodes[j]) this.nodes[j].activity = Math.min(1, this.nodes[j].activity + 0.55);
        });
      }
      if (i === 2) {
        const idx = this.appendToGraph(title, conn);
        if (agent) agent.currentNode = title;
        done?.(idx);
      }
      if (i === 4 && agent) this.ingesting.delete(agent.name);
    };
    let i = 0;
    const tick = () => {
      step(Math.min(i, 4));
      i++;
      if (i < 5) {
        setTimeout(tick, i === 3 ? 700 : 620);
      } else {
        setTimeout(() => {
          this.cb.onPhase(labels, -1);
          if (agent) this.ingesting.delete(agent.name);
        }, 1000);
      }
    };
    setTimeout(tick, 200);
  }

  /* ── physics ────────────────────────────────────────────── */
  private pulseNode(idx: number) {
    const n = this.nodes[idx];
    if (!n) return;
    n.activity = Math.min(1, n.activity + 0.85);
    if (this.REDUCED || !this.liveFn()) return;
    this.flashes.push({ x: n.x, y: n.y, r0: n.r + 2, r1: n.r + 30, t0: performance.now(), dur: 1500 });
  }
  private fieldImpulse(x: number, y: number, force: number, radius: number) {
    for (let i = 0; i < this.N; i++) {
      const n = this.nodes[i];
      const dx = n.x - x;
      const dy = n.y - y;
      const d = Math.hypot(dx, dy);
      if (d > radius || d < 0.5) continue;
      const k = 1 - d / radius;
      n.vx += (dx / d) * k * force * 0.4;
      n.vy += (dy / d) * k * force * 0.4;
      n.activity = Math.min(1, n.activity + k * 0.45);
    }
  }

  private activeAgents(): Agent[] {
    return this.agentsFn().filter(
      (a) => a.currentNode && (a.status === "working" || a.status === "analysing" || this.ingesting.has(a.name)),
    );
  }
  private agentVerb(a: Agent): string {
    const w = String(a.task || a.focus || "").trim().split(/\s+/)[0].toLowerCase();
    return w || (a.status === "analysing" ? "analysing" : "working");
  }

  private stepAgents(now: number, dt: number) {
    const live = this.liveFn() && !this.REDUCED;
    const present: Record<string, boolean> = {};
    this.activeAgents().forEach((a) => {
      const idx = this.indexOfTitle(a.currentNode || "");
      if (idx < 0) return;
      present[a.name] = true;
      const n = this.nodes[idx];
      let ent = this.agentEnts[a.name];
      if (!ent) {
        ent = this.agentEnts[a.name] = {
          px: n.x + 34,
          py: n.y - 34,
          trail: [],
          orbit: hash01(a.name, 3) * 6.28,
          idx,
        };
      }
      ent.idx = idx;
      ent.orbit += (this.ingesting.has(a.name) ? 0.055 : 0.013) * (dt / 16);
      const orad = n.r + 30;
      const tx = n.x + Math.cos(ent.orbit) * orad;
      const ty = n.y + Math.sin(ent.orbit) * orad * 0.66;
      if (live) {
        ent.px += (tx - ent.px) * 0.07;
        ent.py += (ty - ent.py) * 0.07;
      } else {
        ent.px = tx;
        ent.py = ty;
      }
      ent.trail.push([ent.px, ent.py]);
      if (ent.trail.length > 20) ent.trail.shift();
      if (live) {
        n.activity = Math.min(1, n.activity + 0.02 * (dt / 16));
        (n.strongLinks || []).forEach((j) => {
          if (this.nodes[j]) this.nodes[j].activity = Math.min(0.7, this.nodes[j].activity + 0.006 * (dt / 16));
        });
      }
    });
    Object.keys(this.agentEnts).forEach((name) => {
      if (!present[name]) delete this.agentEnts[name];
    });
  }

  private stepPhysics(now: number, dt: number) {
    const live = this.liveFn() && !this.REDUCED;
    const t = now * 0.001;
    for (let i = 0; i < this.N; i++) {
      const n = this.nodes[i];
      if (n.enter < 1 && now >= n.enterAt) n.enter = Math.min(1, n.enter + dt / 460);
      if (n === this.draggingNode) {
        n.x += (n._dragX - n.x) * 0.45;
        n.y += (n._dragY - n.y) * 0.45;
        n.hx = n.x;
        n.hy = n.y;
        n.fieldX = n.x;
        n.fieldY = n.y;
        n.ox = 0;
        n.oy = 0;
        n.vx = 0;
        n.vy = 0;
        continue;
      }
      if (live && n.activity > 0) n.activity = Math.max(0, n.activity - dt * 0.00035);
      const amp = (live ? 0.3 + n.activity * 2.7 + 1.6 / (n.r + 4) : 0) * (1 - this.layoutMix);
      const wx = Math.sin(t * 0.33 + n.hx * 0.01 + n.phase) * 0.7 + Math.sin(t * 0.71 + n.phase * 1.7) * 0.3;
      const wy = Math.sin(t * 0.29 + n.hy * 0.009 + n.phase + 2.1) * 0.7 + Math.sin(t * 0.6 + n.phase * 0.8) * 0.3;
      n.vx = (n.vx + (wx * amp - n.ox) * 0.02) * 0.86;
      n.vy = (n.vy + (wy * amp - n.oy) * 0.02) * 0.86;
      n.ox += n.vx;
      n.oy += n.vy;
      const tx = n.fieldX + n.ox + (n.structuredX - n.fieldX - n.ox) * this.layoutMix;
      const ty = n.fieldY + n.oy + (n.structuredY - n.fieldY - n.oy) * this.layoutMix;
      n.x += (tx - n.x) * (this.layoutMix > 0 ? 0.12 : 0.08);
      n.y += (ty - n.y) * (this.layoutMix > 0 ? 0.12 : 0.08);
    }
  }

  /* ── render ─────────────────────────────────────────────── */
  private tierAlpha(n: RuntimeNode): number {
    return n.level === "pillar" ? 1 : n.level === "primary" ? 0.9 : n.level === "secondary" ? 0.68 : n.level === "peripheral" ? 0.36 : 0.55;
  }
  private screenR(n: RuntimeNode): number {
    const r = n.r * this.cam.zoom * (n.level === "peripheral" ? 0.82 : 1);
    return Math.max(n.level === "peripheral" ? 0.5 : 1.1, r) * (0.35 + 0.65 * n.enter);
  }
  private edgeLine(a: RuntimeNode, b: RuntimeNode, alpha: number, color: string, width: number, dash?: number[]) {
    if (alpha <= 0.003) return;
    const ctx = this.ctx;
    const pa = this.worldToScreen(a.x, a.y);
    const pb = this.worldToScreen(b.x, b.y);
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    if (dash) ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.moveTo(pa[0], pa[1]);
    ctx.lineTo(pb[0], pb[1]);
    ctx.stroke();
    if (dash) ctx.setLineDash([]);
  }

  private ctx!: CanvasRenderingContext2D;

  private render(now: number) {
    const ctx = this.ctx;
    ctx.setTransform(this.DPR, 0, 0, this.DPR, 0, 0);
    ctx.clearRect(0, 0, this.cssW, this.cssH);
    const Z = this.zr();
    const filtOn = this.filterActive();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const structured = this.layoutMix > 0.5;
    const shown: Record<string, number> = {};
    const ekey = (x: number, y: number) => `${Math.min(x, y)}:${Math.max(x, y)}`;

    for (let ei = 0; ei < this.edges.length; ei++) {
      const e0 = this.edges[ei];
      if (e0.tier !== "is-very-strong") continue;
      if (filtOn && !(this.passesFilter(e0.a) && this.passesFilter(e0.b))) continue;
      this.edgeLine(this.nodes[e0.a], this.nodes[e0.b], 0.09 + 0.05 * (0.5 + 0.5 * Math.sin(now * 0.002 + e0.a)), this.col("--ink"), 1);
      shown[ekey(e0.a, e0.b)] = 1;
    }
    if (this.layoutMix > 0.003) {
      for (let ri = 0; ri < this.edges.length; ri++) {
        const er = this.edges[ri];
        if (!er.tier || shown[ekey(er.a, er.b)]) continue;
        if (filtOn && !(this.passesFilter(er.a) && this.passesFilter(er.b))) continue;
        this.edgeLine(this.nodes[er.a], this.nodes[er.b], 0.05 * this.layoutMix, this.col("--ink"), 0.8);
        shown[ekey(er.a, er.b)] = 1;
      }
    }

    if (!this.REDUCED && (structured || this.hoveredIdx !== null)) {
      const flowEdges = structured
        ? this.edges
        : this.edges.filter((e) => e.a === this.hoveredIdx || e.b === this.hoveredIdx);
      for (let fi = 0; fi < flowEdges.length; fi++) {
        const flow = flowEdges[fi];
        if (filtOn && !(this.passesFilter(flow.a) && this.passesFilter(flow.b))) continue;
        if (structured && flow.tier !== "is-very-strong" && fi % 5) continue;
        const from = this.nodes[flow.a];
        const to = this.nodes[flow.b];
        const phase = (now * 0.00016 + hash01(from.label + to.label, 137)) % 1;
        const fp = this.worldToScreen(from.x + (to.x - from.x) * phase, from.y + (to.y - from.y) * phase);
        ctx.globalAlpha = structured ? 0.32 : 0.7;
        ctx.fillStyle = this.col("--l-" + from.layer);
        ctx.beginPath();
        ctx.arc(fp[0], fp[1], structured ? 1.4 : 2.1, 0, 6.283);
        ctx.fill();
      }
    }

    if (this.hoveredIdx !== null) {
      const hn = this.nodes[this.hoveredIdx];
      (hn.strongLinks || []).forEach((j) => {
        this.edgeLine(hn, this.nodes[j], 0.5, this.col("--l-" + hn.layer), 1.4);
        shown[ekey(this.hoveredIdx!, j)] = 1;
      });
    }
    if (this.selectedIdx !== null) {
      const sn = this.nodes[this.selectedIdx];
      (this.adj[this.selectedIdx] || []).forEach((j) => {
        const strong = (sn.strongLinks || []).indexOf(j) !== -1;
        this.edgeLine(sn, this.nodes[j], strong ? 0.5 : 0.2, this.col("--accent"), strong ? 1.5 : 0.9);
        shown[ekey(this.selectedIdx!, j)] = 1;
      });
    }
    for (let tv = 0; tv < this.edges.length; tv++) {
      const et = this.edges[tv];
      if (!et._reveal || et._reveal < now) continue;
      const life = Math.max(0, (et._reveal - now) / 1300);
      this.edgeLine(this.nodes[et.a], this.nodes[et.b], 0.2 + 0.55 * life, this.col("--accent"), 1.3, et._flow > now ? [5, 4] : undefined);
    }
    for (let fx = this.flashEdges.length - 1; fx >= 0; fx--) {
      const fe = this.flashEdges[fx];
      const flt = (now - fe.t0) / fe.dur;
      if (flt >= 1) {
        this.flashEdges.splice(fx, 1);
        continue;
      }
      if (this.nodes[fe.a] && this.nodes[fe.b]) {
        this.edgeLine(this.nodes[fe.a], this.nodes[fe.b], (1 - flt) * 0.85, this.col("--accent"), 1 + (1 - flt) * 2.5);
      }
    }

    const hSet = this.hoveredIdx !== null ? (this.nodes[this.hoveredIdx].strongLinks || []).concat([this.hoveredIdx]) : null;
    const hHas: Record<number, number> = {};
    if (hSet) hSet.forEach((x) => (hHas[x] = 1));
    const labels: { i: number; p: [number, number]; r: number; pri: number }[] = [];

    for (let i = 0; i < this.N; i++) {
      const n = this.nodes[i];
      const p = this.worldToScreen(n.x, n.y);
      if (p[0] < -60 || p[0] > this.cssW + 60 || p[1] < -60 || p[1] > this.cssH + 60) continue;
      const vis = !filtOn || this.passesFilter(i);
      let r = this.screenR(n);
      if (Z < 0.85 && n.level !== "pillar" && n.level !== "primary") r = Math.min(r, 1.3);
      let alpha = this.tierAlpha(n) * (0.3 + 0.7 * n.enter);
      if (!vis) alpha *= 0.09;
      else if (hSet && !hHas[i]) alpha *= 0.16;
      else if (this.selectedIdx !== null && i !== this.selectedIdx && (this.adj[this.selectedIdx] || []).indexOf(i) === -1) alpha *= 0.3;
      const glowNew = n.activeNew && now - n.activeNew < 4200;
      const A = n.activity;

      if ((n.level === "pillar" || n.level === "primary") && vis && r > 1.6) {
        ctx.globalAlpha = (0.1 + A * 0.22) * (hSet && !hHas[i] ? 0.25 : 1);
        ctx.fillStyle = this.col("--l-" + n.layer);
        ctx.beginPath();
        ctx.arc(p[0], p[1], r + 4 + A * 4, 0, 6.283);
        ctx.fill();
      }
      ctx.globalAlpha = Math.min(1, alpha + A * 0.35);
      ctx.fillStyle = this.col("--l-" + n.layer);
      ctx.beginPath();
      ctx.arc(p[0], p[1], r, 0, 6.283);
      ctx.fill();
      if (n.level === "pillar" && vis && r > 2) {
        ctx.globalAlpha = Math.min(1, alpha);
        ctx.strokeStyle = this.col("--ink");
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.arc(p[0], p[1], r, 0, 6.283);
        ctx.stroke();
      }
      if (vis && (A > 0.22 || glowNew || i === this.selectedIdx)) {
        ctx.globalAlpha = glowNew ? 0.9 : 0.3 + A * 0.55;
        ctx.strokeStyle = this.col("--accent");
        ctx.lineWidth = i === this.selectedIdx ? 2 : 1.25;
        ctx.beginPath();
        ctx.arc(p[0], p[1], r + (i === this.selectedIdx ? 5 : 3) + Math.sin(now * 0.006) * 1.1, 0, 6.283);
        ctx.stroke();
      }
      if (n.recent && vis && Z > 0.9) {
        ctx.globalAlpha = 0.5;
        ctx.strokeStyle = this.col("--muted");
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        ctx.arc(p[0], p[1], r + 3.5, 0, 6.283);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (n.markers.length && vis) {
        const s = r + 5;
        ctx.globalAlpha = 0.85;
        ctx.strokeStyle = this.col("--l-warn") || this.col("--accent");
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(p[0], p[1] - s);
        ctx.lineTo(p[0] + s, p[1]);
        ctx.lineTo(p[0], p[1] + s);
        ctx.lineTo(p[0] - s, p[1]);
        ctx.closePath();
        ctx.stroke();
      }
      const want =
        i === this.hoveredIdx ||
        i === this.selectedIdx ||
        (this.layoutMix > 0.08 && (n.level === "pillar" || n.level === "primary" || (Z > 1.1 && n.level === "secondary"))) ||
        (Z > 1.7 && (n.level === "pillar" || n.level === "primary")) ||
        (Z > 2.7 && n.level === "secondary");
      if (want && vis) labels.push({ i, p, r, pri: (i === this.hoveredIdx || i === this.selectedIdx ? 3 : 1) + n.degree * 0.001 });
    }

    ctx.font = "500 11px var(--font-plex-sans), system-ui, sans-serif";
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    labels.sort((a, b) => b.pri - a.pri);
    const occ: [number, number, number, number][] = [];
    for (let lb = 0; lb < labels.length; lb++) {
      const L = labels[lb];
      const nm = this.nodes[L.i].label;
      const tx = L.p[0] + L.r + 5;
      const ty = L.p[1];
      const w = ctx.measureText(nm).width;
      const box: [number, number, number, number] = [tx - 3, ty - 8, tx + w + 3, ty + 8];
      let clash = false;
      for (let oi = 0; oi < occ.length; oi++) {
        const o = occ[oi];
        if (!(box[2] < o[0] || box[0] > o[2] || box[3] < o[1] || box[1] > o[3])) {
          clash = true;
          break;
        }
      }
      if (clash && L.pri < 3) continue;
      occ.push(box);
      const structuredLabelAlpha = L.pri >= 3 || this.layoutMix <= 0.08 ? 1 : Math.min(1, (this.layoutMix - 0.08) / 0.34);
      ctx.globalAlpha = 0.72 * structuredLabelAlpha;
      ctx.fillStyle = this.col("--surface");
      ctx.fillRect(tx - 3, ty - 8, w + 6, 16);
      ctx.globalAlpha = structuredLabelAlpha;
      ctx.fillStyle = this.col("--ink");
      ctx.fillText(nm, tx, ty + 0.5);
    }

    for (let pf = this.flashes.length - 1; pf >= 0; pf--) {
      const F = this.flashes[pf];
      const lt = (now - F.t0) / F.dur;
      if (lt >= 1) {
        this.flashes.splice(pf, 1);
        continue;
      }
      const pp = this.worldToScreen(F.x, F.y);
      ctx.globalAlpha = (1 - lt) * 0.55;
      ctx.strokeStyle = this.col("--accent");
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(pp[0], pp[1], (F.r0 + (F.r1 - F.r0) * lt) * this.cam.zoom, 0, 6.283);
      ctx.stroke();
    }

    this.activeAgents().forEach((a) => {
      const ent = this.agentEnts[a.name];
      if (!ent || !this.nodes[ent.idx]) return;
      const n = this.nodes[ent.idx];
      const ap = this.worldToScreen(ent.px, ent.py);
      const np = this.worldToScreen(n.x, n.y);
      const col = this.col(AGENT_TOKEN[a.name] || "--accent");
      ctx.globalAlpha = 0.4;
      ctx.strokeStyle = col;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(ap[0], ap[1]);
      ctx.lineTo(np[0], np[1]);
      ctx.stroke();
      ctx.setLineDash([]);
      for (let ti = 1; ti < ent.trail.length; ti++) {
        const q0 = this.worldToScreen(ent.trail[ti - 1][0], ent.trail[ti - 1][1]);
        const q1 = this.worldToScreen(ent.trail[ti][0], ent.trail[ti][1]);
        ctx.globalAlpha = (ti / ent.trail.length) * 0.5;
        ctx.strokeStyle = col;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(q0[0], q0[1]);
        ctx.lineTo(q1[0], q1[1]);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(ap[0], ap[1], 4.5, 0, 6.283);
      ctx.fill();
      ctx.globalAlpha = 0.45 + 0.45 * Math.abs(Math.sin(now * 0.005));
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.arc(ap[0], ap[1], 8 + (this.ingesting.has(a.name) ? 2 : 0), 0, 6.283);
      ctx.stroke();
      const verb = this.agentVerb(a);
      const nmeU = a.name.toUpperCase();
      ctx.font = "600 10px var(--font-plex-mono), monospace";
      const lw = Math.max(ctx.measureText(nmeU).width, ctx.measureText(verb).width) + 12;
      let lx = ap[0] + 11;
      let ly = ap[1] - 14;
      if (lx + lw > this.cssW - 6) lx = ap[0] - 11 - lw;
      if (ly < 12) ly = ap[1] + 20;
      ctx.globalAlpha = 0.94;
      ctx.fillStyle = this.col("--surface");
      ctx.fillRect(lx, ly - 9, lw, 24);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = this.col("--hairline");
      ctx.lineWidth = 1;
      ctx.strokeRect(lx, ly - 9, lw, 24);
      ctx.fillStyle = this.col("--ink");
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      ctx.fillText(nmeU, lx + 6, ly - 1);
      ctx.fillStyle = this.col("--muted");
      ctx.font = "10px var(--font-plex-mono), monospace";
      ctx.fillText(verb, lx + 6, ly + 10);
    });

    ctx.globalAlpha = 1;
  }

  private frame(now: number) {
    const dt = Math.min(50, Math.max(1, now - this.last));
    this.last = now;
    this.cam.zoom += (this.cam.tzoom - this.cam.zoom) * 0.18;
    this.cam.x += (this.cam.tx - this.cam.x) * 0.18;
    this.cam.y += (this.cam.ty - this.cam.y) * 0.18;
    this.layoutMix += (this.layoutTarget - this.layoutMix) * (this.REDUCED ? 1 : 0.1);
    if (this.sized && this.visible) {
      this.stepPhysics(now, dt);
      this.stepAgents(now, dt);
      this.render(now);
    }
  }

  /** True when the graph panel is the active view (loop idles otherwise). */
  visible = true;
  setVisible(v: boolean) {
    this.visible = v;
  }

  /* ── pointer / keyboard ─────────────────────────────────── */
  private localXY(e: PointerEvent | WheelEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }
  private pickNode(sx: number, sy: number): number | null {
    let best: number | null = null;
    let bestD = 18;
    for (let i = this.N - 1; i >= 0; i--) {
      if (this.filterActive() && !this.passesFilter(i)) continue;
      const p = this.worldToScreen(this.nodes[i].x, this.nodes[i].y);
      const rr = Math.max(7, this.screenR(this.nodes[i]) + 5);
      const d = Math.hypot(p[0] - sx, p[1] - sy);
      if (d < rr && d < bestD) {
        best = i;
        bestD = d;
      }
    }
    return best;
  }
  private setHover(idx: number | null, xy?: [number, number]) {
    this.hoveredIdx = idx;
    if (idx === null) {
      this.cb.onHover(null);
      return;
    }
    const n = this.nodes[idx];
    const p = xy || this.worldToScreen(n.x, n.y);
    this.cb.onHover({
      index: idx,
      label: n.label,
      type: n.type,
      strongTies: (n.strongLinks || []).length,
      screenX: Math.max(8, Math.min(this.cssW - 228, p[0] + 14)),
      screenY: Math.max(8, Math.min(this.cssH - 48, p[1] + 14)),
    });
  }
  private onPointerMove(e: PointerEvent) {
    const xy = this.localXY(e);
    if (this.ptr.down) {
      const ddx = xy[0] - this.ptr.sx;
      const ddy = xy[1] - this.ptr.sy;
      if (!this.ptr.moved && Math.hypot(ddx, ddy) > 3) this.ptr.moved = true;
      if (this.ptr.moved && this.ptr.mode === "drag" && this.draggingNode) {
        const w = this.screenToWorld(xy[0], xy[1]);
        this.draggingNode._dragX = w[0];
        this.draggingNode._dragY = w[1];
      } else if (this.ptr.moved && this.ptr.mode === "pan") {
        this.cam.x = this.cam.tx = this.ptr.camX - ddx / this.cam.zoom;
        this.cam.y = this.cam.ty = this.ptr.camY - ddy / this.cam.zoom;
      }
      return;
    }
    const hit = this.pickNode(xy[0], xy[1]);
    if (hit !== this.hoveredIdx) this.setHover(hit, xy);
    this.canvas.style.cursor = hit !== null ? "pointer" : "grab";
  }
  private onPointerDown(e: PointerEvent) {
    const xy = this.localXY(e);
    this.ptr.down = true;
    this.ptr.moved = false;
    this.ptr.sx = xy[0];
    this.ptr.sy = xy[1];
    this.ptr.camX = this.cam.x;
    this.ptr.camY = this.cam.y;
    const hit = this.pickNode(xy[0], xy[1]);
    if (hit !== null) {
      this.ptr.mode = "drag";
      this.draggingNode = this.nodes[hit];
      this.draggingNode._dragX = this.draggingNode.x;
      this.draggingNode._dragY = this.draggingNode.y;
    } else {
      this.ptr.mode = "pan";
      this.field.classList.add("panning");
    }
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* capture unsupported */
    }
  }
  private endPointer() {
    this.field.classList.remove("panning");
    this.ptr.down = false;
    this.ptr.mode = null;
    this.draggingNode = null;
  }
  private onPointerUp(e: PointerEvent) {
    const xy = this.localXY(e);
    this.field.classList.remove("panning");
    if (this.ptr.down && !this.ptr.moved) {
      const hit = this.pickNode(xy[0], xy[1]);
      if (hit !== null) {
        this.select(hit);
        if (this.liveFn()) this.pulseNode(hit);
      } else {
        this.closeInspector();
        this.setHover(null);
      }
    }
    this.endPointer();
  }
  private onWheel(e: WheelEvent) {
    e.preventDefault();
    const xy = this.localXY(e);
    const before = this.screenToWorld(xy[0], xy[1]);
    const f = e.deltaY < 0 ? 1.12 : 0.89;
    this.cam.zoom = this.cam.tzoom = Math.max(this.baseZoom() * 0.55, Math.min(this.baseZoom() * 7, this.cam.zoom * f));
    const after = this.screenToWorld(xy[0], xy[1]);
    this.cam.x += before[0] - after[0];
    this.cam.y += before[1] - after[1];
    this.cam.tx = this.cam.x;
    this.cam.ty = this.cam.y;
  }
  private onKey(e: KeyboardEvent) {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      if (!this.primaryCycle.length) return;
      this.cyclePos = (this.cyclePos + (e.key === "ArrowRight" ? 1 : -1) + this.primaryCycle.length) % this.primaryCycle.length;
      const idx = this.primaryCycle[this.cyclePos];
      this.setHover(idx);
      this.select(idx);
    } else if (e.key === "Enter" && this.hoveredIdx !== null) {
      this.select(this.hoveredIdx);
    } else if (e.key === "Escape") {
      this.closeInspector();
    }
  }

  /** Called after construction once the 2d context is available. */
  private attachCtx() {
    this.ctx = this.canvas.getContext("2d") as CanvasRenderingContext2D;
  }
}

/* local maths mirroring lib/graph-data so the engine owns runtime tiering */
function nodeRadiusFor(degree: number): number {
  if (degree >= 16) return 9 + (Math.min(degree - 16, 24) / 24) * 3.5;
  if (degree >= 9) return 6.5 + ((degree - 9) / 7) * 2;
  if (degree >= 4) return 4 + ((degree - 4) / 5) * 1.6;
  return 2.4 + Math.max(0, degree - 1) * 0.5;
}
function levelFor(degree: number): "pillar" | "primary" | "secondary" | "peripheral" {
  return degree >= 16 ? "pillar" : degree >= 9 ? "primary" : degree >= 4 ? "secondary" : "peripheral";
}
