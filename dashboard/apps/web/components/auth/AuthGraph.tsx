"use client";

import { useEffect, useRef } from "react";
import { buildGraphData, nodeRadius, LAYERS, LAYER_COUNTS } from "@dashboard/shared";

/**
 * The auth screens' right panel: "The Quiet Observatory".
 *
 * The vault's real knowledge graph — the same deterministic build the workspace
 * renders (seed 42) — read as a night sky rather than a diagram. Each of the 246
 * notes is a star: its layer sets the colour, its degree the size. The field
 * drifts on its own epicycles while the whole disc turns slowly; stars twinkle
 * on individual periods; the graph-walker now and then walks a light path of two
 * or three links; a comet crosses, and a new star kindles as a note is added.
 *
 * Theme-aware: dark mode is a night sky (additive glow on ink); light mode is a
 * star chart on paper (ink stars with colour halos, source-over). The palette is
 * rebuilt whenever `data-theme` changes.
 *
 * Inert and decorative (aria-hidden): the page's real content is the form.
 */

const DATA = buildGraphData();
const REV_PERIOD_S = 300; // one slow turn of the sky
const TILT = 0.58; // squash Y into a disc, so it reads as a galaxy, not a scatter
const DIAGONAL = -0.32; // radians the disc is laid on

type Mode = "dark" | "light";

interface Star {
  x: number; // normalized -1..1
  y: number;
  z: number; // 0 far .. 1 near
  r: number; // sprite diameter, css px at rest
  base: number; // base alpha
  hue: number; // sprite index (layer)
  phase: number;
  tw: number; // twinkle speed
  drift: number; // epicycle radius (normalized)
  igniteAt: number; // when it last kindled (0 = never)
}

interface Thread {
  path: number[]; // 2–3 node indices the walker travels
  t0: number;
  dur: number;
}

interface Comet {
  x0: number; y0: number; x1: number; y1: number;
  t0: number; dur: number; hue: number;
}

interface Palette {
  mode: Mode;
  blend: GlobalCompositeOperation;
  layer: [number, number, number][];
  sprites: HTMLCanvasElement[];
  ink: [number, number, number];
  ground: [number, number, number];
}

function cssToRgb(color: string): [number, number, number] {
  const c = document.createElement("canvas");
  c.width = c.height = 1;
  const g = c.getContext("2d");
  if (!g) return [200, 200, 200];
  g.fillStyle = "#888";
  g.fillStyle = color;
  g.fillRect(0, 0, 1, 1);
  const d = g.getImageData(0, 0, 1, 1).data;
  return [d[0], d[1], d[2]];
}

const mixTo = (rgb: [number, number, number], target: number, t: number): string =>
  `rgb(${Math.round(rgb[0] + (target - rgb[0]) * t)},${Math.round(rgb[1] + (target - rgb[1]) * t)},${Math.round(rgb[2] + (target - rgb[2]) * t)})`;

/** A star sprite. Dark mode: hot near-white core bleeding into the layer hue.
 *  Light mode: an ink point with a soft colour halo, so it plots on paper. */
function makeStar(rgb: [number, number, number], mode: Mode): HTMLCanvasElement {
  const S = 64;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d")!;
  const [r, gg, b] = rgb;
  const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  if (mode === "dark") {
    grad.addColorStop(0, mixTo(rgb, 255, 0.72));
    grad.addColorStop(0.18, `rgba(${r},${gg},${b},0.95)`);
    grad.addColorStop(0.45, `rgba(${r},${gg},${b},0.22)`);
  } else {
    grad.addColorStop(0, mixTo(rgb, 0, 0.62));
    grad.addColorStop(0.16, mixTo(rgb, 0, 0.2));
    grad.addColorStop(0.4, `rgba(${r},${gg},${b},0.34)`);
    grad.addColorStop(0.7, `rgba(${r},${gg},${b},0.1)`);
  }
  grad.addColorStop(1, `rgba(${r},${gg},${b},0)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, S, S);
  return c;
}

function currentMode(): Mode {
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr === "dark") return "dark";
  if (attr === "light") return "light";
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function buildPalette(panel: HTMLElement): Palette {
  const cs = getComputedStyle(panel);
  const read = (v: string, fb: string) => cs.getPropertyValue(v).trim() || fb;
  const mode = currentMode();
  const layer = LAYERS.map((l) => cssToRgb(read(`--l-${l}`, "#8ab")));
  return {
    mode,
    blend: mode === "dark" ? "lighter" : "source-over",
    layer,
    sprites: layer.map((c) => makeStar(c, mode)),
    ink: cssToRgb(read("--axg-ink", "#e8ebf0")),
    ground: cssToRgb(read("--axg-ground", "#101418")),
  };
}

export function AuthGraph() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    const panel = (canvas.closest(".authx-visual-col") as HTMLElement | null) ?? document.documentElement;

    const reduce =
      typeof window !== "undefined" && !!window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // Normalize the relaxed layout into a centered unit disc.
    const { nodes, edges, adj, fieldPos } = DATA;
    let minx = 1e9, maxx = -1e9, miny = 1e9, maxy = -1e9;
    for (const p of fieldPos) {
      minx = Math.min(minx, p.x); maxx = Math.max(maxx, p.x);
      miny = Math.min(miny, p.y); maxy = Math.max(maxy, p.y);
    }
    const cx0 = (minx + maxx) / 2, cy0 = (miny + maxy) / 2;
    const span = Math.max(maxx - minx, maxy - miny) / 2;

    const layerIndex: Record<string, number> = {};
    LAYERS.forEach((l, i) => (layerIndex[l] = i));

    const stars: Star[] = nodes.map((n, i) => {
      const p = fieldPos[i];
      const nx = (p.x - cx0) / span;
      const ny = (p.y - cy0) / span;
      const h = (Math.abs(Math.sin(i * 12.9898) * 43758.5453) % 1);
      const tier = n.degree >= 16 ? "pillar" : n.degree >= 9 ? "primary" : n.degree >= 4 ? "secondary" : "peripheral";
      return {
        x: nx,
        y: ny,
        z: h,
        r: 5 + nodeRadius(n.degree) * 2.2,
        base: tier === "pillar" ? 0.95 : tier === "primary" ? 0.78 : tier === "secondary" ? 0.5 : 0.28,
        hue: layerIndex[n.layer],
        phase: h * Math.PI * 2,
        tw: 0.5 + h * 1.4,
        drift: 0.01 + h * 0.024,
        igniteAt: 0,
      };
    });

    // layer centroids → nebula haze anchors, plus a bright central core
    const centroids = LAYERS.map((_, li) => {
      let sx = 0, sy = 0, k = 0;
      stars.forEach((s) => { if (s.hue === li) { sx += s.x; sy += s.y; k++; } });
      return { x: sx / Math.max(1, k), y: sy / Math.max(1, k) };
    });

    let W = 0, H = 0, DPR = 0;
    const cv: HTMLCanvasElement = canvas;
    function resize() {
      const rect = panel.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      // only touch the backing store when it actually changes: assigning
      // width/height clears the canvas, so a spurious observer tick (e.g. from
      // a sibling resizing) must not wipe a frame
      if (w === W && h === H && dpr === DPR) return;
      W = w;
      H = h;
      DPR = dpr;
      cv.width = W * DPR;
      cv.height = H * DPR;
      cv.style.width = W + "px";
      cv.style.height = H + "px";
    }
    resize();

    let pal = buildPalette(panel);

    // real resizes repaint even without the rAF loop (reduced-motion), so the
    // canvas is never left blank after its backing store is reallocated
    const ro = new ResizeObserver(() => {
      const before = W + "x" + H;
      resize();
      if (reduce && before !== W + "x" + H) render(performance.now());
    });
    ro.observe(panel);

    const threads: Thread[] = [];
    const comets: Comet[] = [];
    let lastThread = performance.now();
    let nextThreadGap = 2200 + Math.random() * 2200;
    let lastIgnite = performance.now();
    let nextIgniteGap = 4200 + Math.random() * 3800;
    let lastComet = performance.now();
    let nextCometGap = 9000 + Math.random() * 9000;

    const t0 = performance.now();

    function project(s: Star, angle: number, now: number): [number, number, number] {
      const ca = Math.cos(angle + DIAGONAL);
      const sa = Math.sin(angle + DIAGONAL);
      // each star also wanders a small epicycle, so the field breathes rather
      // than turning as one rigid plate
      const dx = Math.sin(now * 0.0006 * s.tw + s.phase) * s.drift;
      const dy = Math.cos(now * 0.00052 * s.tw + s.phase * 1.3) * s.drift;
      const sx0 = s.x + dx;
      const sy0 = s.y + dy;
      const drift = 1 - s.z * 0.12;
      const rx = (sx0 * ca - sy0 * sa) * drift;
      const ry = (sx0 * sa + sy0 * ca) * drift;
      const sx = W / 2 + rx * (W * 0.62);
      const sy = H / 2 + ry * TILT * (H * 0.72);
      const twinkle = 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(now * 0.0011 * s.tw + s.phase));
      return [sx, sy, twinkle];
    }

    function drawHaze(angle: number, now: number) {
      ctx!.globalCompositeOperation = pal.blend;
      const breathe = 0.76 + 0.24 * Math.sin(now * 0.00018);
      centroids.forEach((c, li) => {
        const [sx, sy] = project({ x: c.x, y: c.y, z: 0, r: 0, base: 0, hue: li, phase: 0, tw: 0, drift: 0, igniteAt: 0 }, angle, 0);
        const rad = Math.max(W, H) * 0.42;
        const [r, g, b] = pal.layer[li];
        const a = (pal.mode === "dark" ? 0.11 : 0.07) * breathe;
        const grad = ctx!.createRadialGradient(sx, sy, 0, sx, sy, rad);
        grad.addColorStop(0, `rgba(${r},${g},${b},${a})`);
        grad.addColorStop(0.5, `rgba(${r},${g},${b},${a * 0.34})`);
        grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
        ctx!.fillStyle = grad;
        ctx!.fillRect(0, 0, W, H);
      });
      // a wide cool core, like the galactic centre
      const [ir, ig, ib] = pal.ink;
      const cg = ctx!.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.5);
      cg.addColorStop(0, `rgba(${ir},${ig},${ib},${(pal.mode === "dark" ? 0.06 : 0.035) * breathe})`);
      cg.addColorStop(1, "rgba(0,0,0,0)");
      ctx!.fillStyle = cg;
      ctx!.fillRect(0, 0, W, H);
    }

    function drawStars(angle: number, now: number) {
      ctx!.globalCompositeOperation = pal.blend;
      for (const s of stars) {
        const [sx, sy, tw] = project(s, angle, now);
        let a = s.base * tw * (0.7 + s.z * 0.5);
        if (s.igniteAt) {
          const e = (now - s.igniteAt) / 2600;
          if (e >= 1) s.igniteAt = 0;
          else {
            const k = e < 0.45 ? e / 0.45 : 1 - (e - 0.45) / 0.55 * 0.55;
            a = Math.min(1, a + k * 0.9);
          }
        }
        ctx!.globalAlpha = Math.min(1, a);
        const d = s.r;
        ctx!.drawImage(pal.sprites[s.hue], sx - d / 2, sy - d / 2, d, d);
      }
      ctx!.globalAlpha = 1;
    }

    function drawKinds(angle: number, now: number) {
      ctx!.globalCompositeOperation = pal.blend;
      for (const s of stars) {
        if (!s.igniteAt) continue;
        const e = (now - s.igniteAt) / 2600;
        if (e >= 1) continue;
        const [sx, sy] = project(s, angle, now);
        const [r, g, b] = pal.layer[s.hue];
        ctx!.globalAlpha = (1 - e) * (pal.mode === "dark" ? 0.5 : 0.6);
        ctx!.strokeStyle = pal.mode === "dark" ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},0.9)`;
        ctx!.lineWidth = 1;
        ctx!.beginPath();
        ctx!.arc(sx, sy, 6 + e * 46, 0, Math.PI * 2);
        ctx!.stroke();
      }
      ctx!.globalAlpha = 1;
    }

    function drawThreads(angle: number, now: number) {
      ctx!.globalCompositeOperation = pal.blend;
      for (let i = threads.length - 1; i >= 0; i--) {
        const th = threads[i];
        const e = (now - th.t0) / th.dur;
        if (e >= 1) { threads.splice(i, 1); continue; }
        const pts = th.path.map((idx) => project(stars[idx], angle, now));
        const seg: number[] = [];
        let total = 0;
        for (let k = 1; k < pts.length; k++) {
          const d = Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
          seg.push(d); total += d;
        }
        if (total < 1) continue;
        const reach = Math.min(1, e / 0.55) * total;
        const fade = e < 0.55 ? e / 0.55 : 1 - (e - 0.55) / 0.45;
        const travel: [number, number][] = [[pts[0][0], pts[0][1]]];
        let acc = 0;
        for (let k = 1; k < pts.length; k++) {
          if (acc + seg[k - 1] <= reach) { travel.push([pts[k][0], pts[k][1]]); acc += seg[k - 1]; }
          else {
            const t = (reach - acc) / seg[k - 1];
            travel.push([pts[k - 1][0] + (pts[k][0] - pts[k - 1][0]) * t, pts[k - 1][1] + (pts[k][1] - pts[k - 1][1]) * t]);
            break;
          }
        }
        const head = travel[travel.length - 1];
        const [r, g, b] = pal.layer[stars[th.path[0]].hue];
        const grad = ctx!.createLinearGradient(pts[0][0], pts[0][1], head[0], head[1]);
        grad.addColorStop(0, `rgba(${r},${g},${b},0)`);
        grad.addColorStop(1, `rgba(${r},${g},${b},${0.75 * fade})`);
        ctx!.globalAlpha = 1;
        ctx!.strokeStyle = grad;
        ctx!.lineWidth = 1;
        ctx!.beginPath();
        ctx!.moveTo(travel[0][0], travel[0][1]);
        for (let k = 1; k < travel.length; k++) ctx!.lineTo(travel[k][0], travel[k][1]);
        ctx!.stroke();
        ctx!.fillStyle = pal.mode === "dark" ? `rgba(255,255,255,${0.85 * fade})` : `rgba(${r},${g},${b},${0.95 * fade})`;
        ctx!.beginPath();
        ctx!.arc(head[0], head[1], 1.7, 0, Math.PI * 2);
        ctx!.fill();
      }
    }

    function drawComets(now: number) {
      ctx!.globalCompositeOperation = pal.blend;
      for (let i = comets.length - 1; i >= 0; i--) {
        const c = comets[i];
        const e = (now - c.t0) / c.dur;
        if (e >= 1) { comets.splice(i, 1); continue; }
        const ease = e * e * (3 - 2 * e);
        const cx = c.x0 + (c.x1 - c.x0) * ease;
        const cy = c.y0 + (c.y1 - c.y0) * ease;
        const px = W / 2 + cx * (W * 0.5);
        const py = H / 2 + cy * TILT * (H * 0.6);
        const te = Math.max(0, ease - 0.07);
        const tx = W / 2 + (c.x0 + (c.x1 - c.x0) * te) * (W * 0.5);
        const ty = H / 2 + (c.y0 + (c.y1 - c.y0) * te) * TILT * (H * 0.6);
        const fade = Math.sin(Math.PI * e);
        const [r, g, b] = pal.layer[c.hue];
        const grad = ctx!.createLinearGradient(tx, ty, px, py);
        grad.addColorStop(0, `rgba(${r},${g},${b},0)`);
        grad.addColorStop(1, `rgba(${r},${g},${b},${0.9 * fade})`);
        ctx!.globalAlpha = 1;
        ctx!.strokeStyle = grad;
        ctx!.lineWidth = 1.4;
        ctx!.beginPath();
        ctx!.moveTo(tx, ty);
        ctx!.lineTo(px, py);
        ctx!.stroke();
        ctx!.fillStyle = pal.mode === "dark" ? `rgba(255,255,255,${fade})` : `rgba(${r},${g},${b},${fade})`;
        ctx!.beginPath();
        ctx!.arc(px, py, 1.8, 0, Math.PI * 2);
        ctx!.fill();
      }
    }

    function spawnThread(now: number) {
      if (!edges.length) return;
      const e = edges[Math.floor(Math.random() * edges.length)];
      const path = [e.source, e.target];
      // sometimes the walker continues from the arrival node — a link, then a
      // relink: the path reads as the graph being traversed, not one line
      if (Math.random() < 0.55) {
        const nb = adj[e.target];
        if (nb && nb.length) {
          let nxt = nb[Math.floor(Math.random() * nb.length)];
          if (nxt === e.source && nb.length > 1) nxt = nb[(nb.indexOf(nxt) + 1) % nb.length];
          if (nxt !== e.target) path.push(nxt);
        }
      }
      threads.push({ path, t0: now, dur: 1600 + Math.random() * 1000 });
    }

    function spawnComet(now: number) {
      const a = Math.random() * Math.PI * 2;
      comets.push({
        x0: -Math.cos(a) * 1.35, y0: -Math.sin(a) * 1.35,
        x1: Math.cos(a) * 1.35, y1: Math.sin(a) * 1.35,
        t0: now, dur: 2600 + Math.random() * 1300,
        hue: Math.floor(Math.random() * LAYERS.length),
      });
    }

    function schedule(now: number) {
      if (now - lastThread > nextThreadGap) {
        lastThread = now;
        nextThreadGap = 2200 + Math.random() * 2400;
        spawnThread(now);
      }
      if (now - lastIgnite > nextIgniteGap) {
        lastIgnite = now;
        nextIgniteGap = 4200 + Math.random() * 4200;
        stars[Math.floor(Math.random() * stars.length)].igniteAt = now;
      }
      if (now - lastComet > nextCometGap) {
        lastComet = now;
        nextCometGap = 9000 + Math.random() * 10000;
        spawnComet(now);
      }
    }

    function render(now: number) {
      const angle = ((now - t0) / 1000 / REV_PERIOD_S) * Math.PI * 2;
      ctx!.setTransform(DPR, 0, 0, DPR, 0, 0);
      ctx!.clearRect(0, 0, W, H);
      drawHaze(angle, now);
      drawStars(angle, now);
      drawKinds(angle, now);
      drawThreads(angle, now);
      drawComets(now);
      ctx!.globalCompositeOperation = "source-over";
      ctx!.globalAlpha = 1;
    }

    let raf = 0;
    let running = false;

    function loop(now: number) {
      if (!running) return;
      schedule(now);
      render(now);
      raf = requestAnimationFrame(loop);
    }

    function start() {
      if (running || reduce) return;
      running = true;
      raf = requestAnimationFrame(loop);
    }
    function stop() {
      running = false;
      cancelAnimationFrame(raf);
    }

    // theme change → rebuild the palette and sprites, then repaint
    const onTheme = () => {
      pal = buildPalette(panel);
      if (reduce) render(performance.now());
    };
    const themeObserver = new MutationObserver(onTheme);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });

    let mq: MediaQueryList | null = null;
    const onSystem = () => { if (!document.documentElement.getAttribute("data-theme")) onTheme(); };
    try {
      mq = window.matchMedia("(prefers-color-scheme: dark)");
      mq.addEventListener("change", onSystem);
    } catch {
      mq = null;
    }

    if (reduce) {
      render(t0 + 2000);
    } else {
      start();
    }

    const onVis = () => {
      if (reduce) return;
      if (document.hidden) stop();
      else start();
    };
    document.addEventListener("visibilitychange", onVis);

    return () => {
      stop();
      ro.disconnect();
      themeObserver.disconnect();
      mq?.removeEventListener("change", onSystem);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  return (
    <figure className="authx-graph" aria-hidden="true">
      <canvas ref={canvasRef} className="authx-starfield" />
      <span className="authx-sky-shade" />
      <figcaption className="authx-readout">
        <div className="authx-readout-row">
          <span className="authx-rk">vault</span>
          <span className="authx-rv">~/vault/03-Areas/concepts</span>
        </div>
        <div className="authx-readout-row">
          <span className="authx-rk">graph</span>
          <span className="authx-rv">
            {DATA.nodes.length} concepts · {DATA.edges.length} links
          </span>
        </div>
        <div className="authx-legend">
          {LAYERS.map((l) => (
            <span className="authx-leg" key={l}>
              <span className="authx-leg-dot" style={{ background: `var(--l-${l})` }} />
              {l}
              <span className="authx-leg-n">{LAYER_COUNTS[l]}</span>
            </span>
          ))}
        </div>
      </figcaption>
    </figure>
  );
}
