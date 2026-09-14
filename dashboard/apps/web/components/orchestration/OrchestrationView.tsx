"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listAllChats, fetchSpawns, type ChatSession, type SpawnEvent } from "@/lib/api";
import { SpawnTree } from "./SpawnTree";
import { RunTimeline } from "./RunTimeline";
import { RunDetail } from "./RunDetail";

/**
 * Runs that involve orchestration: a chat session where the agent delegated to
 * sub-agents. There is no separate "run" entity — a run IS a session, and the
 * delegation trace lives in that session's spawn log on the agent service.
 */
export function OrchestrationView() {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const [spawns, setSpawns] = useState<SpawnEvent[]>([]);
  const [spawnsLoading, setSpawnsLoading] = useState(false);
  const [selectedSpawn, setSelectedSpawn] = useState<SpawnEvent | null>(null);
  const lastFocus = useRef<HTMLElement | null>(null);
  const drawerRef = useRef<HTMLElement | null>(null);

  const loadRuns = useCallback(async () => {
    try {
      const all = await listAllChats();
      setSessions(all);
    } catch {
      setError("Could not load runs.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  // Load the selected run's spawns (and refresh on a timer while it's running).
  useEffect(() => {
    if (!selectedRun) {
      setSpawns([]);
      return;
    }
    let cancelled = false;
    setSpawnsLoading(true);
    const load = async () => {
      try {
        const s = await fetchSpawns(selectedRun);
        if (!cancelled) setSpawns(s);
      } catch {
        if (!cancelled) setSpawns([]);
      } finally {
        if (!cancelled) setSpawnsLoading(false);
      }
    };
    void load();
    const timer = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [selectedRun]);

  const closeDetail = useCallback(() => {
    setSelectedSpawn(null);
    if (lastFocus.current) {
      lastFocus.current.focus();
      lastFocus.current = null;
    }
  }, []);

  // Selecting a sub-agent opens the detail drawer; record where focus came from
  // (so close restores it) and move focus into the panel.
  const openSpawn = useCallback((s: SpawnEvent) => {
    lastFocus.current = document.activeElement as HTMLElement | null;
    setSelectedSpawn(s);
    requestAnimationFrame(() => drawerRef.current?.focus());
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && selectedSpawn) closeDetail();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [closeDetail, selectedSpawn]);

  const activeRun = useMemo(() => sessions.find((s) => s.id === selectedRun) ?? null, [sessions, selectedRun]);
  const runList = sessions.filter((s) => s.messageCount > 0);

  return (
    <section className="view active" data-od-id="view-orchestration">
      <div className="orch-index">
        <div className="orch-head">
          <div>
            <h2>Orchestration</h2>
            <div className="orch-sub">
              {loading ? "Loading runs…" : `${runList.length} run${runList.length === 1 ? "" : "s"} · orchestrator + sub-agents`}
            </div>
          </div>
        </div>

        <div className="orch-split">
          <aside className="orch-runs" data-od-id="orch-runs">
            {error ? <div className="orch-colempty">{error}</div> : null}
            {!loading && !runList.length ? (
              <div className="orch-colempty">No runs yet. Chat with an agent that has spawn_subagent enabled.</div>
            ) : null}
            {runList.map((s) => (
              <button
                key={s.id}
                type="button"
                className={`orch-run ${s.id === selectedRun ? "is-active" : ""}`}
                onClick={() => {
                  setSelectedRun(s.id);
                  setSelectedSpawn(null);
                }}
              >
                <span className="orr-title">{s.title}</span>
                <span className="orr-meta">
                  {s.messageCount} messages · {relativeTime(s.updatedAt)}
                </span>
              </button>
            ))}
          </aside>

          <div className="orch-canvas" data-od-id="orch-canvas">
            {!selectedRun ? (
              <div className="orch-colempty">Select a run to see its delegation tree.</div>
            ) : spawnsLoading && !spawns.length ? (
              <div className="orch-colempty">Loading delegation…</div>
            ) : (
              <>
                <div data-od-id="orch-spawn-tree">
                  <h2 className="orch-tl-h">Delegation</h2>
                  <SpawnTree
                    rootLabel={activeRun ? activeRun.title : "Orchestrator"}
                    spawns={spawns}
                    selectedId={selectedSpawn?.id ?? null}
                    onSelect={openSpawn}
                  />
                </div>
                <div data-od-id="orch-run-timeline">
                  <h2 className="orch-tl-h">Sub-agent timeline</h2>
                  <RunTimeline spawns={spawns} selectedId={selectedSpawn?.id ?? null} onSelect={openSpawn} />
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      <button
        type="button"
        className={`orch-scrim ${selectedSpawn ? "on" : ""}`}
        aria-label="Close sub-agent detail"
        tabIndex={selectedSpawn ? 0 : -1}
        onClick={closeDetail}
      />
      <aside
        className={`orch-drawer ${selectedSpawn ? "on" : ""}`}
        data-od-id="orch-spawn-panel"
        ref={drawerRef}
        tabIndex={-1}
        aria-hidden={!selectedSpawn}
        aria-label="Sub-agent detail"
      >
        {selectedSpawn ? <RunDetail spawn={selectedSpawn} onClose={closeDetail} /> : null}
      </aside>
    </section>
  );
}

function relativeTime(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
