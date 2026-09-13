"use client";

import { useMemo } from "react";
import { useWorkspace } from "@/components/providers/workspace";
import { GrowthCurve, monthsFromCreation } from "@/components/charts/GrowthCurve";
import { DOCS } from "@/lib/docs";
import { LAYERS, LAYER_COUNTS } from "@dashboard/shared";
import { IconFolder } from "@/components/ui/icons";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const INDEX_DOCS: { key: string; label: string; size: string }[] = [
  { key: "vault-index", label: "vault-index.md", size: "3,1 KB" },
  { key: "graph-walk", label: "graph-walk.md", size: "2,4 KB" },
  { key: "taxonomy", label: "taxonomy.md", size: "2,8 KB" },
];
const FEATURED_DOCS: { key: string; label: string; size: string }[] = [
  { key: "mev", label: "MEV", size: "1,9 KB" },
  { key: "bonding-curve", label: "Bonding Curve", size: "2,1 KB" },
  { key: "memecoin", label: "Memecoin", size: "1,7 KB" },
];
const AGENT_DOCS: { key: string; label: string; size: string }[] = [
  { key: "agent-readme", label: "agent-readme.md", size: "2,6 KB" },
  { key: "agent-manifest", label: "agent-manifest.yaml", size: "1,2 KB" },
];
const ANALYSES: { key: string; title: string; meta: string; tags: string[] }[] = [
  { key: "ana-graph-health", title: "Graph health — audit 05 Sep", meta: "05 Sep 2026 · 13:30 · 12 min", tags: ["audit", "hub"] },
  { key: "ana-orphans", title: "Orphan notes & new hubs", meta: "05 Sep 2026 · 11:00 · 8 min", tags: ["topology"] },
  { key: "ana-mempool", title: "Mempool density → application layer", meta: "04 Sep 2026 · 22:10 · 15 min", tags: ["correlation", "trend"] },
  { key: "ana-agent", title: "Agent behavior summary (30 days)", meta: "03 Sep 2026 · 18:00 · 4 min", tags: ["agent"] },
];

export function MapView() {
  const { graph, openReader, focusNodeByTitle } = useWorkspace();

  const months = useMemo(() => {
    const counts: Record<string, number> = {};
    graph?.nodes.forEach((n) => {
      const mi = MONTHS.indexOf(String(n.created).split(" ")[1]);
      if (mi >= 0) counts[`${mi + 1}`] = (counts[`${mi + 1}`] || 0) + 1;
    });
    return counts;
  }, [graph]);

  const points = useMemo(() => monthsFromCreation(months), [months]);

  const hubs = useMemo(
    () =>
      graph
        ? graph.nodes
            .map((n, i) => ({ n, i }))
            .filter((x) => x.n.degree >= 12)
            .sort((a, b) => b.n.degree - a.n.degree)
            .slice(0, 4)
        : [],
    [graph],
  );
  const recent = useMemo(() => (graph ? graph.nodes.filter((n) => n.recent) : []), [graph]);
  const flagged = useMemo(() => (graph ? graph.nodes.filter((n) => n.markers.length > 0) : []), [graph]);

  const openDoc = (key: string) => {
    const d = DOCS[key];
    if (!d) return;
    openReader({ title: d.file, kind: d.kind === "ana" ? "analysis" : d.kind, body: d.body, activeKey: key });
  };

  return (
    <section className="view active" data-od-id="view-map">
      <div className="panel-header">
        <h2>Map &amp; index</h2>
        <div className="graph-meta">
          <span>{graph?.nodes.length ?? 0} nodes</span>
        </div>
      </div>
      <div className="mi-grid">
        <div className="mi-panel" data-od-id="map-widget">
          <div className="panel-header">
            <h2>Vault map</h2>
          </div>
          <div className="mi-body">
            <div className="mi-section-label">Growth over time</div>
            <GrowthCurve points={points} caption="cumulative concept notes" />

            <div className="mi-section-label">Distribution per layer</div>
            {LAYERS.map((layer) => {
              const count = LAYER_COUNTS[layer as keyof typeof LAYER_COUNTS];
              const cells = Math.max(1, Math.round(count / 5));
              return (
                <div className="map-layer" key={layer}>
                  <span className="ml-name">{layer}</span>
                  <span className="ml-track">
                    {Array.from({ length: cells }).map((_, k) => (
                      <span
                        className="ml-cell"
                        key={k}
                        style={{ background: `var(--l-${layer})` }}
                        title={`${layer} · ${count} notes`}
                      />
                    ))}
                  </span>
                  <span className="ml-count">{count}</span>
                </div>
              );
            })}

            <div className="mi-section-label">Hotspots</div>
            <MapStrip label="hub · deg ≥ 12" empty="no hubs">
              {hubs.map(({ n }, i) => (
                <span key={n.id}>
                  {i > 0 ? " · " : ""}
                  <button type="button" title={`Open ${n.label} in the graph`} onClick={() => focusNodeByTitle(n.label)}>
                    {n.label}
                    <span className="ms-n">{n.degree}</span>
                  </button>
                </span>
              ))}
            </MapStrip>
            <MapStrip label="update 05 Sep" empty="no updates">
              {recent.map((n, i) => (
                <span key={n.id}>
                  {i > 0 ? " · " : ""}
                  <button type="button" title={`Open ${n.label} in the graph`} onClick={() => focusNodeByTitle(n.label)}>
                    {n.label}
                  </button>
                </span>
              ))}
            </MapStrip>
            <MapStrip label="open flags" empty="no flags">
              {flagged.map((n, i) => (
                <span key={n.id}>
                  {i > 0 ? " · " : ""}
                  <button type="button" title={`Open ${n.label} in the graph`} onClick={() => focusNodeByTitle(n.label)}>
                    {n.label}
                    <span className="ms-n">{n.markers.length || n.status}</span>
                  </button>
                </span>
              ))}
            </MapStrip>
          </div>
        </div>

        <div className="mi-panel" data-od-id="index-widget">
          <div className="panel-header">
            <h2>Index</h2>
          </div>
          <div className="mi-body">
            <div className="doc-group-label">Map &amp; index</div>
            {INDEX_DOCS.map((d) => (
              <DocItem key={d.key} label={d.label} size={d.size} onClick={() => openDoc(d.key)} />
            ))}
            <div className="doc-group-label">Featured notes</div>
            {FEATURED_DOCS.map((d) => (
              <DocItem key={d.key} label={d.label} size={d.size} onClick={() => openDoc(d.key)} />
            ))}
            <div className="doc-group-label">Agent</div>
            {AGENT_DOCS.map((d) => (
              <DocItem key={d.key} label={d.label} size={d.size} onClick={() => openDoc(d.key)} />
            ))}
            <div className="doc-group-label">
              Analysis <span className="grp-tag">sample</span>
            </div>
            {ANALYSES.map((a) => (
              <button className="ana-item" key={a.key} onClick={() => openDoc(a.key)}>
                <span className="ana-title">{a.title}</span>
                <span className="ana-meta">{a.meta}</span>
                <span className="ana-tags">
                  {a.tags.map((t) => (
                    <span className="ana-tag" key={t}>
                      {t}
                    </span>
                  ))}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function MapStrip({ label, empty, children }: { label: string; empty: string; children: React.ReactNode }) {
  const hasChildren = Array.isArray(children) ? children.length > 0 : !!children;
  return (
    <div className="map-strip">
      <span className="ms-label">{label}</span>
      <span className="ms-items">{hasChildren ? children : <span className="ms-empty">{empty}</span>}</span>
    </div>
  );
}

function DocItem({ label, size, onClick }: { label: string; size: string; onClick: () => void }) {
  return (
    <button className="doc-item" onClick={onClick}>
      <span className="doc-icon">
        <IconFolder />
      </span>
      <span className="doc-name">{label}</span>
      <span className="doc-size">{size}</span>
    </button>
  );
}
