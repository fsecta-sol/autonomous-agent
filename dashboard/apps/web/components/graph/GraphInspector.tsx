"use client";

import { useState } from "react";
import type { GraphData } from "@dashboard/shared";
import type { KnowledgeNode } from "@dashboard/shared";
import { linkGroups, whyPreview } from "@/lib/markdown";
import { nodeLevel } from "@dashboard/shared";

interface GraphInspectorProps {
  node: KnowledgeNode;
  graph: GraphData;
  onClose: () => void;
  onOpenNote: () => void;
  onCite: (title: string) => void;
}

const TYPE_PREVIEW: Record<string, (t: string, l: string) => string> = {
  system: (t, l) => `${t} is a system-level mechanism — one of the moving parts that makes ${l} protocols function in practice, not just in theory.`,
  fundamental: (t, l) => `${t} is a foundational primitive most ${l} designs build on without restating.`,
  economy: (t, l) => `${t} shapes incentives inside ${l}: who gets paid, who bears risk, and when.`,
  programming: (t, l) => `${t} is an implementation detail with outsized consequences for ${l} correctness.`,
  concept: (t, l) => `${t} is a recurring idea across ${l} — worth its own note because it keeps resurfacing.`,
  "cross-cutting": (t, l) => `${t} cuts across layers; it shows up wherever ${l} intersects with the rest of the graph.`,
  trading: (t, l) => `${t} is a trading-side pattern — how ${l} mechanics get expressed in market behavior.`,
  blockchain: (t, l) => `${t} is chain-level plumbing underneath ${l}.`,
};

function LinkList({ titles, onCite }: { titles: string[]; onCite: (t: string) => void }) {
  if (!titles.length) return <span className="k">—</span>;
  return (
    <>
      {titles.map((t, i) => (
        <span key={t}>
          {i > 0 ? ", " : ""}
          <button type="button" className="cite" onClick={() => onCite(t)}>
            [{t}]
          </button>
        </span>
      ))}
    </>
  );
}

export function GraphInspector({ node, graph, onClose, onOpenNote, onCite }: GraphInspectorProps) {
  const [expanded, setExpanded] = useState(false);
  const idx = graph.nodes.findIndex((n) => n.id === node.id);
  const g = linkGroups(graph, idx);
  const preview = TYPE_PREVIEW[node.type](node.label, node.layer);
  const contributors = [
    ["Kai", "Vale", "Tally", "Moss", "Wick", "Echo"][idx % 6],
    ["Kai", "Vale", "Tally", "Moss", "Wick", "Echo"][(idx * 7 + node.label.length) % 6],
  ].filter((v, i, a) => a.indexOf(v) === i);

  return (
    <div className="inspector" data-od-id="inspector">
      {node.markers.length ? (
        <div className="flag-badges">
          {node.markers.map((m) => (
            <span className="flag-badge" key={m}>
              [{m}]
            </span>
          ))}
        </div>
      ) : node.status !== "active" ? (
        <div className="flag-badges">
          <span className="flag-badge">{node.status}</span>
        </div>
      ) : null}
      <div className="inspector-head">
        <span className="title">{node.label}</span>
        <button className="inspector-close" aria-label="Close inspector" onClick={onClose}>
          ×
        </button>
      </div>
      <hr />
      <div className="inspector-row">
        <span className="k">type</span>
        <span className="v text">{node.type}</span>
      </div>
      <div className="inspector-row">
        <span className="k">layer</span>
        <span className="v text">{node.layer}</span>
      </div>
      <div className="inspector-row">
        <span className="k">tier</span>
        <span className="v text">{nodeLevel(node.degree)}</span>
      </div>
      <div className="inspector-row">
        <span className="k">updated</span>
        <span className="v">
          {node.updated}
          {node.recent ? <span className="recent-dot" title="updated in the last 14 days" /> : null}
        </span>
      </div>
      <hr />
      <div className="inspector-section-label">What</div>
      <p className="inspector-preview">{preview}</p>
      <div className="inspector-section-label">Related</div>
      <p className="inspector-related">
        <LinkList titles={[...g.builds, ...g.enables].slice(0, 5)} onCite={onCite} />
      </p>
      <div className="inspector-section-label">Contributed by</div>
      <p className="inspector-related">{contributors.join(", ")}</p>

      {expanded ? (
        <>
          <div className="inspector-row">
            <span className="k">created</span>
            <span className="v">{node.created}</span>
          </div>
          <div className="inspector-row">
            <span className="k">sources</span>
            <span className="v">{node.sources}</span>
          </div>
          <div className="inspector-row">
            <span className="k">links out / in</span>
            <span className="v">
              {node.linksOut} / {node.linksIn}
            </span>
          </div>
          <div className="inspector-section-label">Why it exists / why it works</div>
          <p className="inspector-preview">{whyPreview(node)}</p>
          <div className="inspector-section-label">Builds on</div>
          <p className="inspector-related">
            <LinkList titles={g.builds} onCite={onCite} />
          </p>
          <div className="inspector-section-label">Enables</div>
          <p className="inspector-related">
            <LinkList titles={g.enables} onCite={onCite} />
          </p>
        </>
      ) : null}

      <div className="inspector-actions">
        <button
          className="inspector-more-btn"
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
        <button className="inspector-open-btn" type="button" onClick={onOpenNote}>
          Open full note
        </button>
      </div>
    </div>
  );
}
