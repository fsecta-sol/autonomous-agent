"use client";

import { useState } from "react";
import type { KnowledgeHealth } from "@/lib/research-loop";
import { StateNote, Stat, truncate } from "./shared";

type Panel = "health" | "unknowns" | "conflicts" | "orphans" | "lifecycle";

const PANELS: Array<{ id: Panel; label: string }> = [
  { id: "health", label: "Health" },
  { id: "unknowns", label: "Unknowns" },
  { id: "conflicts", label: "Conflicts" },
  { id: "orphans", label: "Orphans" },
  { id: "lifecycle", label: "Lifecycle" },
];

/**
 * The Knowledge Manager's operational view. It is NOT the relationship graph —
 * it is the health/lifecycle surface over the same Markdown vault, backed by the
 * engine's `KnowledgeManager.validate_graph()` report (served at `/api/research/meta`).
 *
 * Where the engine exposes a number it is shown; where it does not, the field is
 * marked "not exposed" with the endpoint that would be needed — never a fabricated
 * value (the vault counts are real, but e.g. per-node confidence is not in the API).
 */
export function KnowledgeManager({
  health,
  state,
  error,
  onRetry,
}: {
  health: KnowledgeHealth | null;
  state: "loading" | "ready" | "error";
  error: string;
  onRetry: () => void;
}) {
  const [panel, setPanel] = useState<Panel>("health");

  if (state === "loading" && !health) {
    return <StateNote kind="loading" title="Loading knowledge state…" />;
  }
  if (state === "error" && !health) {
    return (
      <StateNote
        kind="error"
        title="Unable to load the Knowledge Manager."
        detail={error}
        onRetry={onRetry}
      />
    );
  }
  if (!health) {
    return <StateNote kind="empty" title="No knowledge report available." detail="The agent's Knowledge Manager returned nothing." />;
  }

  return (
    <div className="km">
      <nav className="km-tabs" role="tablist" aria-label="Knowledge sections">
        {PANELS.map((p) => (
          <button
            key={p.id}
            type="button"
            role="tab"
            aria-selected={panel === p.id}
            className={`km-tab ${panel === p.id ? "is-active" : ""}`}
            onClick={() => setPanel(p.id)}
          >
            {p.label}
            {p.id === "unknowns" && health.open_unknowns ? <span className="km-tab-count">{health.open_unknowns}</span> : null}
            {p.id === "conflicts" && health.conflicts ? <span className="km-tab-count">{health.conflicts}</span> : null}
            {p.id === "orphans" && health.orphan_nodes ? <span className="km-tab-count">{health.orphan_nodes}</span> : null}
          </button>
        ))}
      </nav>

      <div className="km-body">
        {panel === "health" ? <Health h={health} /> : null}
        {panel === "unknowns" ? <NodesPanel h={health} kind="unknown" /> : null}
        {panel === "conflicts" ? <NodesPanel h={health} kind="conflict" /> : null}
        {panel === "orphans" ? <NodesPanel h={health} kind="orphan" /> : null}
        {panel === "lifecycle" ? <Lifecycle h={health} /> : null}
      </div>
    </div>
  );
}

/* ── health ─────────────────────────────────────────────────────────────── */

function Health({ h }: { h: KnowledgeHealth }) {
  const attention = h.open_unknowns + h.conflicts + h.orphan_nodes + h.broken_links + h.missing_sources;
  return (
    <div className="km-panel">
      <div className="km-hero">
        <div className="km-hero-n">
          <div className="km-hero-num">{h.nodes.toLocaleString()}</div>
          <div className="km-hero-lbl">entities</div>
        </div>
        <div className="km-hero-n">
          <div className="km-hero-num">{h.relationships.toLocaleString()}</div>
          <div className="km-hero-lbl">relationships</div>
        </div>
        <div className="km-hero-n">
          <div className="km-hero-num" data-attn={attention > 0 ? "" : undefined}>{attention.toLocaleString()}</div>
          <div className="km-hero-lbl">need attention</div>
        </div>
      </div>

      <div className="km-grid">
        <Stat k="Verified" v={h.verified} title="nodes with a verified_at stamp" />
        <Stat k="Unverified" v={h.unverified} />
        <Stat k="Open unknowns" v={h.open_unknowns} />
        <Stat k="Conflicts" v={h.conflicts} title="nodes carrying an unresolved Conflict section" />
        <Stat k="Orphans" v={h.orphan_nodes} title="nodes with zero relationships" />
        <Stat k="Broken links" v={h.broken_links} title="[[links]] pointing at a node that does not exist" />
        <Stat k="Missing sources" v={h.missing_sources} title="concepts with no source recorded" />
        <Stat k="Superseded" v={h.superseded} />
        <Stat k="Dangling index" v={h.dangling_index} />
      </div>

      <div className="km-note">
        Every figure above comes from <code>KnowledgeManager.validate_graph()</code> — the vault’s
        own health report — not from a client estimate.
      </div>
    </div>
  );
}

/* ── unknowns / conflicts / orphans ─────────────────────────────────────── */

function NodesPanel({ h, kind }: { h: KnowledgeHealth; kind: "unknown" | "conflict" | "orphan" }) {
  const cfg = {
    unknown: {
      title: "Open unknowns",
      ids: h.unknown_nodes,
      count: h.open_unknowns,
      empty: "No open unknowns — the graph has no unanswered gap nodes.",
      note:
        "The engine stores unknowns as first-class `## Unknown` nodes. Per-unknown confidence and the " +
        "iteration that raised it live in the vault note body / the research iteration's knowledge_updates, " +
        "not this summary — open the node in the graph, or the run's Knowledge Impact tab, for provenance.",
    },
    conflict: {
      title: "Knowledge conflicts",
      ids: h.conflict_nodes,
      count: h.conflicts,
      empty: "No conflicts recorded.",
      note:
        "A conflict is a node carrying an unresolved `## Conflict` section (the manager writes `Status: UNRESOLVED` " +
        "with the competing claim and its evidence). Resolution state is in the note body; this endpoint does not " +
        "expose it, so no resolution workflow is shown.",
    },
    orphan: {
      title: "Orphaned knowledge",
      ids: h.orphans,
      count: h.orphan_nodes,
      empty: "No orphans — every entity has at least one relationship.",
      note:
        "Orphans are nodes with zero relationships. Relationship count per node is not in this summary; " +
        "open the node in the graph to inspect its edges. `missing_sources` (" + h.missing_sources +
        ") is the related set of concepts with no recorded source.",
    },
  }[kind];

  return (
    <div className="km-panel">
      <div className="km-panel-head">
        <span className="km-panel-title">{cfg.title}</span>
        <span className="km-panel-count">{cfg.count}</span>
      </div>
      {cfg.ids.length ? (
        <ul className="km-list">
          {cfg.ids.map((id) => (
            <li key={id} className="km-item">
              <span className="km-item-id">[[{id}]]</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="rl-muted">{cfg.empty}</div>
      )}
      <div className="km-note">{cfg.note}</div>
      {kind !== "unknown" ? null : null}
    </div>
  );
}

/* ── lifecycle ──────────────────────────────────────────────────────────── */

/**
 * The engine's real stage names (`knowledge/observability.py` OPERATIONS and
 * `lifecycle.py` decisions). Counts come only from `validate_graph`; stages the
 * report cannot quantify are shown with `—` and an explicit "not exposed" mark
 * rather than a guessed number.
 */
const LIFECYCLE: Array<{ stage: string; blurb: string; count?: (h: KnowledgeHealth) => number | null }> = [
  { stage: "Create / Extract", blurb: "a candidate fact is proposed through the manager" },
  { stage: "Dedup / Classify", blurb: "NEW · UPDATE · DUPLICATE · CONFLICT · SUPERSEDE" },
  { stage: "Verify", blurb: "evidence attached; verified at confidence", count: (h) => h.verified },
  { stage: "Unverified", blurb: "evidence attached but confidence not asserted", count: (h) => h.unverified },
  { stage: "Connect", blurb: "typed relationships written (reciprocal edge too)", count: (h) => h.relationships },
  { stage: "Supersede", blurb: "an older node replaced by a newer one", count: (h) => h.superseded },
  { stage: "Conflict", blurb: "an unresolved contradiction recorded on the node", count: (h) => h.conflicts },
  { stage: "Orphan", blurb: "a node with no relationships", count: (h) => h.orphan_nodes },
];

function Lifecycle({ h }: { h: KnowledgeHealth }) {
  return (
    <div className="km-panel">
      <ol className="km-life">
        {LIFECYCLE.map((s, i) => {
          const c = s.count ? s.count(h) : null;
          return (
            <li key={s.stage} className="km-life-step" data-has={c != null ? "" : undefined}>
              <span className="km-life-idx rl-mono">{String(i + 1).padStart(2, "0")}</span>
              <span className="km-life-main">
                <span className="km-life-stage">{s.stage}</span>
                <span className="km-life-blurb">{s.blurb}</span>
              </span>
              <span className="km-life-count" title={c == null ? "not exposed by this endpoint" : undefined}>
                {c == null ? "—" : c.toLocaleString()}
              </span>
            </li>
          );
        })}
      </ol>
      <div className="km-note">
        Stages marked <code>—</code> have no count in <code>validate_graph()</code>. The per-operation
        lifecycle log (<code>knowledge/observability.py</code>, operations like <code>KNOWLEDGE_CREATED</code>,
        <code>RELATION_CREATED</code>, <code>EVIDENCE_ADDED</code>) is written to a JSONL file on the agent and is
        <strong> not yet exposed over HTTP</strong>. A counts endpoint over that log would populate “Create/Extract”
        and “Dedup/Classify”.
      </div>
      <UnavailableNote />
    </div>
  );
}

function UnavailableNote() {
  return (
    <div className="km-unavailable">
      <span className="km-unavailable-badge">Not exposed</span>
      <span>
        Cross-run knowledge provenance (“which research run changed this node?”) is recorded in the knowledge
        observability log with <code>research_id</code> / <code>task_id</code> fields, but no endpoint serves it yet.
        Until one exists this view shows the vault-level aggregates only — it does not invent provenance links.
      </span>
    </div>
  );
}

/** Exposed for potential reuse by a future per-node detail surface. */
export function truncateId(id: string, max = 48): string {
  return truncate(id, max).text;
}
