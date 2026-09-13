"use client";

import { useMemo, useRef, useState } from "react";

export interface GrowthPoint {
  mo: string;
  add: number;
  cum: number;
}

/**
 * Single-series cumulative growth curve. Minimal by design: no oversized
 * end marker, no focus ring. Hover shows a hairline crosshair and a compact
 * tooltip; the last point carries only a small solid dot.
 */
export function GrowthCurve({
  points,
  caption,
  height = 126,
}: {
  points: GrowthPoint[];
  caption?: string;
  height?: number;
}) {
  const plotRef = useRef<HTMLDivElement>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const { linePath, areaPath, dots } = useMemo(() => {
    const n = points.length;
    if (!n) return { linePath: "", areaPath: "", dots: [] as { x: number; y: number }[] };
    const total = points[n - 1].cum;
    const max = Math.max(50, Math.ceil(total / 50) * 50);
    const px = (i: number) => (n === 1 ? 50 : (i / (n - 1)) * 100);
    const py = (v: number) => 100 - (v / max) * 100;
    const d = points.map((p, i) => `${i ? "L" : "M"}${px(i).toFixed(2)},${py(p.cum).toFixed(2)}`).join(" ");
    return {
      linePath: d,
      areaPath: `${d} L100,100 L0,100 Z`,
      dots: points.map((p, i) => ({ x: px(i), y: py(p.cum) })),
    };
  }, [points]);

  if (!points.length) {
    return <div className="gc-caption">No growth recorded yet.</div>;
  }

  const onMove = (e: React.PointerEvent) => {
    const r = plotRef.current?.getBoundingClientRect();
    if (!r || r.width === 0) return;
    const ratio = (e.clientX - r.left) / r.width;
    const i = Math.max(0, Math.min(points.length - 1, Math.round(ratio * (points.length - 1))));
    setHoverIdx(i);
  };

  const hov = hoverIdx != null ? points[hoverIdx] : null;
  const hovDot = hoverIdx != null ? dots[hoverIdx] : null;

  return (
    <div className="growth-curve" data-od-id="growth-curve">
      <div className="gc-plot" ref={plotRef} style={{ height }}>
        <svg className="gc-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <path className="gc-area" d={areaPath} />
          <path className="gc-line" d={linePath} />
        </svg>
        {dots.map((d, i) => (
          <div
            key={points[i].mo}
            className={`gc-dot ${i === dots.length - 1 ? "gc-end" : ""}`}
            style={{ left: `${d.x}%`, top: `${d.y}%` }}
            title={`${points[i].mo} · ${points[i].cum} total`}
          />
        ))}
        {hov && hovDot ? (
          <>
            <div className="gc-cross" style={{ display: "block", left: `${hovDot.x}%` }} />
            <div
              className="gc-tip"
              style={{
                left: `${hovDot.x}%`,
                top: `${hovDot.y}%`,
                transform: hoverIdx === 0 ? "translate(0,-100%)" : hoverIdx === points.length - 1 ? "translate(-100%,-100%)" : "translate(-50%,-100%)",
              }}
            >
              <b>{hov.cum}</b> notes
              <br />
              <span className="gc-tip-sub">
                {hov.mo} 2026 · +{hov.add}
              </span>
            </div>
          </>
        ) : null}
        <div
          className="gc-hit"
          role="img"
          aria-label="Cumulative concept notes by month"
          onPointerMove={onMove}
          onPointerLeave={() => setHoverIdx(null)}
        />
      </div>
      <div className="gc-ticks">
        {points.map((p) => (
          <span key={p.mo}>{p.mo}</span>
        ))}
      </div>
      {caption ? (
        <div className="gc-caption">
          {points[0].mo}–{points[points.length - 1].mo} 2026 · {caption}
        </div>
      ) : null}
    </div>
  );
}

/** Build cumulative points from the graph's created-month distribution. */
export function monthsFromCreation(months: Record<string, number>): GrowthPoint[] {
  const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const mi = MO.map((_, i) => i).filter((i) => months[`${i + 1}`]);
  if (!mi.length) return [];
  let cum = 0;
  return mi.map((i) => {
    const add = months[`${i + 1}`] || 0;
    cum += add;
    return { mo: MO[i], add, cum };
  });
}
