"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useWorkspace } from "@/components/providers/workspace";
import { GraphEngine, type GraphSnapshot, type HoverInfo } from "./engine";
import { GraphInspector } from "./GraphInspector";
import { ReaderOverlay } from "@/components/map/ReaderOverlay";
import { FilterMenu } from "./FilterMenu";
import { IconChevronDown, IconFit, IconMaximize, IconMinimize, IconZoomIn, IconZoomOut } from "@/components/ui/icons";
import type { GraphMode } from "@dashboard/shared";
import { noteMarkdown } from "@/lib/markdown";
import { LAYERS } from "@dashboard/shared";

const GRAPH_TYPES = ["system", "fundamental", "economy", "programming", "concept", "cross-cutting", "trading", "blockchain"];

export function KnowledgeGraph() {
  const {
    graph,
    graphState,
    graphError,
    reloadGraph,
    agents,
    liveRef,
    feedLive,
    view,
    registerEngine,
    focusRequest,
    openReader,
    graphFocusMode,
    setGraphFocusMode,
  } = useWorkspace();

  const fieldRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<GraphEngine | null>(null);
  const agentsRef = useRef(agents);

  const [hover, setHover] = useState<HoverInfo | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [snapshot, setSnapshot] = useState<GraphSnapshot | null>(null);
  const [mode, setMode] = useState<GraphMode>("field");
  const [phase, setPhase] = useState<{ labels: string[]; current: number } | null>(null);
  const [activeLayers, setActiveLayers] = useState<Set<string>>(new Set());
  const [activeTypes, setActiveTypes] = useState<Set<string>>(new Set());
  const [layerOpen, setLayerOpen] = useState(false);
  const [typeOpen, setTypeOpen] = useState(false);

  // keep the engine's agent source fresh without rebuilding it
  useEffect(() => {
    agentsRef.current = agents;
  }, [agents]);

  // create the engine once the graph data is ready
  useEffect(() => {
    if (!graph || graphState !== "success") return;
    const canvas = canvasRef.current;
    const field = fieldRef.current;
    if (!canvas || !field) return;

    const engine = new GraphEngine(canvas, field, graph, {
      onHover: setHover,
      onSelect: setSelected,
      onPhase: (labels, current) => setPhase(current < 0 ? null : { labels, current }),
      onSnapshot: setSnapshot,
    });
    engine.setAgentsSource(() => agentsRef.current);
    engine.setLiveSource(() => liveRef.current);
    engineRef.current = engine;
    registerEngine(engine);
    engine.mount();
    setSnapshot(engine.getSnapshot());

    return () => {
      engine.destroy();
      engineRef.current = null;
      registerEngine(null);
    };
  }, [graph, graphState, registerEngine, liveRef]);

  // idle the loop when the graph view is not visible
  useEffect(() => {
    engineRef.current?.setVisible(view === "graph");
  }, [view]);

  // respond to focus requests from other views
  useEffect(() => {
    if (!focusRequest || !engineRef.current) return;
    const idx = engineRef.current.indexOfTitle(focusRequest.title);
    if (idx >= 0) engineRef.current.selectAndCenter(idx);
  }, [focusRequest]);

  const onModeChange = useCallback((next: GraphMode) => {
    setMode(next);
    engineRef.current?.setMode(next);
  }, []);

  const onLayersChange = useCallback(
    (next: Set<string>) => {
      setActiveLayers(next);
      engineRef.current?.setFilters(next, activeTypes);
    },
    [activeTypes],
  );
  const onTypesChange = useCallback(
    (next: Set<string>) => {
      setActiveTypes(next);
      engineRef.current?.setFilters(activeLayers, next);
    },
    [activeLayers],
  );
  const clearFilters = useCallback(() => {
    const empty = new Set<string>();
    setActiveLayers(empty);
    setActiveTypes(empty);
    engineRef.current?.setFilters(empty, empty);
  }, []);

  const layerCounts = snapshot?.layers ?? {};
  const typeCounts = snapshot?.types ?? {};

  const selectedNode =
    graph && selected != null && selected >= 0 && selected < graph.nodes.length ? graph.nodes[selected] : null;

  const openNoteFor = useCallback(
    (idx: number) => {
      if (!graph) return;
      const n = graph.nodes[idx];
      if (!n) return;
      openReader({ title: `notes/${n.label}.md`, kind: "note", body: noteMarkdown(graph, n), activeKey: null });
    },
    [graph, openReader],
  );

  const cite = useCallback(
    (title: string) => {
      const eng = engineRef.current;
      if (!eng) return;
      const idx = eng.indexOfTitle(title);
      if (idx >= 0) eng.selectAndCenter(idx);
    },
    [],
  );

  const nodeCount = snapshot?.nodeCount ?? graph?.nodes.length ?? 0;
  const filtersActive = activeLayers.size > 0 || activeTypes.size > 0;

  return (
    <section className={`view graph-panel ${view === "graph" ? "active" : ""} ${!feedLive ? "is-paused" : ""}`} data-od-id="graph-panel">
      <div className="panel-header">
        <h2>Knowledge graph</h2>
        <div className="graph-meta">
          <span>
            {filtersActive && snapshot
              ? `${snapshot.visibleCount} of ${nodeCount} concepts`
              : `${nodeCount} nodes`}
          </span>
          <span className="dot">·</span>
          <span className="legend-item" title="Dashed ring = note updated within the last 14 days">
            ◌ recent
          </span>
          <span className="dot">·</span>
          <span className="legend-item" title="Diamond outline = note needs review">
            ◇ needs review
          </span>
          <span className="dot">·</span>
          <div className="graph-mode">
            <label htmlFor="graph-mode-select">Visualization mode</label>
            <select
              id="graph-mode-select"
              data-graph-mode
              aria-label="Visualization mode"
              value={mode}
              onChange={(e) => onModeChange(e.target.value as GraphMode)}
            >
              <option value="field">Field</option>
              <option value="structured">Structured</option>
            </select>
          </div>
        </div>
      </div>

      <div className="filter-bar" data-od-id="graph-filters">
        <div className="filter-dd">
          <button
            className="filter-btn"
            aria-haspopup="menu"
            aria-expanded={layerOpen}
            onClick={() => {
              setLayerOpen((v) => !v);
              setTypeOpen(false);
            }}
          >
            <span>Layer</span>
            <span className="filter-count" hidden={activeLayers.size === 0}>
              {activeLayers.size}
            </span>
            <IconChevronDown />
          </button>
          {layerOpen ? (
            <FilterMenu
              values={LAYERS}
              counts={layerCounts}
              active={activeLayers}
              onChange={onLayersChange}
              onClose={() => setLayerOpen(false)}
              colorPrefix="--l-"
            />
          ) : null}
        </div>
        <div className="filter-dd">
          <button
            className="filter-btn"
            aria-haspopup="menu"
            aria-expanded={typeOpen}
            onClick={() => {
              setTypeOpen((v) => !v);
              setLayerOpen(false);
            }}
          >
            <span>Type</span>
            <span className="filter-count" hidden={activeTypes.size === 0}>
              {activeTypes.size}
            </span>
            <IconChevronDown />
          </button>
          {typeOpen ? (
            <FilterMenu
              values={GRAPH_TYPES}
              counts={typeCounts}
              active={activeTypes}
              onChange={onTypesChange}
              onClose={() => setTypeOpen(false)}
              colorPrefix={null}
            />
          ) : null}
        </div>
        {filtersActive ? (
          <button className="filter-clear" onClick={clearFilters}>
            Clear filters
          </button>
        ) : null}
      </div>

      <div className="graph-field" ref={fieldRef} id="graph-field">
        <canvas
          ref={canvasRef}
          id="graph-canvas"
          tabIndex={0}
          role="img"
          data-od-id="graph-canvas"
          aria-label="Knowledge field — a living particle map of the vault. Concepts cluster into semantic neighbourhoods and relationships stay implicit until a concept is focused. Arrow keys move between primary concepts; Enter opens the focused concept."
        />

        {phase ? (
          <div className="graph-phase" data-od-id="graph-phase">
            {phase.labels.map((label, i) => (
              <span
                key={label}
                className={`gp-step ${i < phase.current ? "is-done" : ""} ${i === phase.current ? "is-now" : ""}`}
              >
                {label}
              </span>
            ))}
          </div>
        ) : null}

        {hover ? (
          <div
            className="graph-hover"
            id="graph-hover"
            role="status"
            aria-live="polite"
            style={{ left: hover.screenX, top: hover.screenY }}
          >
            <strong>{hover.label}</strong>
            <div className="graph-hover-meta">
              {hover.type} / {hover.strongTies} strong ties
            </div>
          </div>
        ) : null}

        {graphState === "loading" ? (
          <div className="graph-loading-msg" role="status">
            <div>
              <div className="line1">Assembling the knowledge field…</div>
              <div>246 concepts are being placed into their semantic neighbourhoods.</div>
            </div>
          </div>
        ) : null}

        {graphState === "error" ? (
          <div className="graph-empty-msg" role="alert">
            <div>
              <div className="line1">The knowledge graph could not be assembled.</div>
              <div>{graphError ?? "The graph data source did not answer."}</div>
              <button className="graph-retry-btn" type="button" onClick={reloadGraph}>
                Retry
              </button>
            </div>
          </div>
        ) : null}

        {graphState === "success" && nodeCount === 0 ? (
          <div className="graph-empty-msg">
            <div>
              <div className="line1">The vault is empty.</div>
              <div>Run research or process the inbox to create the first concept note.</div>
            </div>
          </div>
        ) : null}

        {selectedNode && graph ? (
          <GraphInspector
            node={selectedNode}
            graph={graph}
            onClose={() => engineRef.current?.closeInspector()}
            onOpenNote={() => openNoteFor(selected!)}
            onCite={cite}
          />
        ) : null}

        <div className="graph-controls" data-od-id="graph-controls">
          <button
            className="ctrl-btn"
            type="button"
            aria-label={graphFocusMode ? "Exit full screen" : "Maximize the graph"}
            aria-pressed={graphFocusMode}
            title="Full screen (Esc to exit)"
            data-od-id="graph-focus-btn"
            onClick={() => setGraphFocusMode(!graphFocusMode)}
          >
            {graphFocusMode ? <IconMinimize /> : <IconMaximize />}
          </button>
          <button className="ctrl-btn" aria-label="Zoom in" onClick={() => engineRef.current?.zoomBy(1.3)}>
            <IconZoomIn />
          </button>
          <button className="ctrl-btn" aria-label="Zoom out" onClick={() => engineRef.current?.zoomBy(1 / 1.3)}>
            <IconZoomOut />
          </button>
          <button className="ctrl-btn" aria-label="Fit to view" onClick={() => engineRef.current?.fit()}>
            <IconFit />
          </button>
        </div>
      </div>

      <ReaderOverlay />
    </section>
  );
}
