"use client";

import { useEffect, useMemo, useRef } from "react";
import { useWorkspace } from "@/components/providers/workspace";
import { stateLabel, StatusLamp } from "@/components/execution/AgentTelemetryStrip";
import { GrowthCurve, monthsFromCreation, type GrowthPoint } from "@/components/charts/GrowthCurve";
import { formatAge } from "@/lib/telemetry-format";
import type { TelemetryFeed } from "@/lib/useTelemetry";
import type { ChatSession } from "@/lib/api";
import {
  IconActivity,
  IconChat,
  IconCheck,
  IconClock,
  IconClose,
  IconGraph,
  IconPlug,
  IconTrash,
} from "@/components/ui/icons";
import type { Agent, TelemetryState } from "@dashboard/shared";

export type RailTab = "telemetry" | "history" | "config";

/** One row of the live task list, derived from real run state. */
export interface TaskRow {
  id: string;
  label: string;
  state: "running" | "paused" | "queued";
  detail?: string;
}

/** One line of the agent activity feed, folded from the real execution trace. */
export interface ActivityRow {
  id: string;
  at: number;
  agent?: string;
  text: string;
  tone: "ok" | "run" | "err";
}

/** One sub-agent the orchestrator spawned this session, folded from the spawn log. */
export interface SubAgentRow {
  id: string;
  /** the sub-agent's role */
  agent: string;
  /** the task the orchestrator handed it */
  task: string;
  status: "running" | "done" | "error";
  /** epoch ms it started (or finished) — for ordering */
  at: number;
  /** settled duration ("46.9s"), or null while still running */
  duration: string | null;
}

/** Movement (px) that turns a press on a chat row into a drag-paint sweep
 *  rather than a click. Below it, a press is a normal click (open / toggle). */
const DRAG_PAINT_THRESHOLD = 5;

const RAIL_TABS: { key: RailTab; label: string; icon: React.ReactNode }[] = [
  { key: "telemetry", label: "Console", icon: <IconActivity /> },
  { key: "history", label: "History", icon: <IconChat /> },
  { key: "config", label: "Config", icon: <IconPlug /> },
];

/** Group graph nodes into `{ "5": 131, … }` creation-month buckets. */
function monthsFromNodes(nodes: { created: string }[]): Record<string, number> {
  const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const out: Record<string, number> = {};
  for (const n of nodes) {
    const token = n.created.split(" ")[1];
    const idx = MO.indexOf(token);
    if (idx >= 0) out[String(idx + 1)] = (out[String(idx + 1)] ?? 0) + 1;
  }
  return out;
}

/** The telemetry state for a swarm row, from the live feed with a health fallback. */
function rowState(agent: Agent, feed: TelemetryFeed): TelemetryState {
  if (feed.offline) return "offline";
  const t = feed.data?.agents[agent.id];
  if (t) return t.state;
  return agent.health.beatOk ? "idle" : "stale";
}

/**
 * The console rail: operational context that stays beside the conversation —
 * the swarm and each agent's live state, the tasks actually in flight, the
 * agent's execution activity, and the knowledge graph's growth. History and the
 * per-agent Config pane live here too, so the center stays pure conversation.
 *
 * Every reading is real: swarm state and tasks fold from the polled telemetry
 * feed and the live run; activity folds from the execution trace; growth folds
 * from the graph. Nothing here is a fabricated metric — an absent reading says so.
 */
export function ConsoleRail({
  agent,
  feed,
  tasks,
  subagents,
  activity,
  sessions,
  sessionId,
  onOpenSession,
  onDeleteSession,
  selecting,
  selectedIds,
  allSelected,
  deleting,
  bulkError,
  onToggleSelecting,
  onToggleSession,
  onSelectAll,
  onBulkDelete,
  onPaint,
  tab,
  onTab,
  configSlot,
  onFocusGraph,
  onClose,
}: {
  agent: Agent;
  feed: TelemetryFeed;
  tasks: TaskRow[];
  /** sub-agents the orchestrator spawned this session (newest first) */
  subagents: SubAgentRow[];
  activity: ActivityRow[];
  sessions: ChatSession[];
  sessionId: string | null;
  onOpenSession: (id: string) => void;
  onDeleteSession: (s: ChatSession) => void;
  /** true while the history panel is in multi-select mode */
  selecting: boolean;
  /** ids currently ticked for bulk deletion */
  selectedIds: Set<string>;
  /** true when every loaded session is ticked (flips "select all" → "deselect all") */
  allSelected: boolean;
  /** true while a bulk delete is in flight (locks the controls) */
  deleting: boolean;
  /** a bulk-delete failure to surface under the header, or null */
  bulkError: string | null;
  onToggleSelecting: () => void;
  onToggleSession: (id: string) => void;
  onSelectAll: () => void;
  onBulkDelete: () => void;
  /** set one row's tick directly (drag-paint): `on` true = select, false = deselect */
  onPaint: (id: string, on: boolean) => void;
  tab: RailTab;
  onTab: (t: RailTab) => void;
  /** the per-agent configuration pane, mounted only when its tab is active */
  configSlot: React.ReactNode;
  onFocusGraph: (title: string) => void;
  /** when provided, the rail shows a close control (it is a drawer) */
  onClose?: () => void;
}) {
  const { agents, graph, openAgent } = useWorkspace();

  const swarm = useMemo(
    () =>
      agents.map((a) => ({
        agent: a,
        state: rowState(a, feed),
        active: a.id === agent.id,
      })),
    [agents, feed, agent.id],
  );

  const growth: GrowthPoint[] = useMemo(
    () => (graph ? monthsFromCreation(monthsFromNodes(graph.nodes)) : []),
    [graph],
  );
  const growthTotal = growth.length ? growth[growth.length - 1].cum : 0;

  /* ── drag-paint over the history list ─────────────────────────────────────
     Hold the left button and sweep down the list to select; hold the right
     button and sweep to deselect. A press that never crosses the movement
     threshold stays a plain click (open a chat, or toggle one row in select
     mode), so the sweep never steals a normal click. Mouse-only: a touch drag
     must keep scrolling the list, not painting it. */
  const histRef = useRef<HTMLElement | null>(null);
  const selectingRef = useRef(selecting);
  selectingRef.current = selecting;
  const deletingRef = useRef(deleting);
  deletingRef.current = deleting;
  /** set true the instant a sweep paints, so the click the browser fires on
   *  pointerup is swallowed instead of toggling/open the row under the cursor */
  const paintedRef = useRef(false);

  useEffect(() => {
    // the section only exists while the History tab is mounted; re-run when the
    // tab changes so the listeners attach to the real node, not a null ref
    if (tab !== "history") return;
    const el = histRef.current;
    if (!el) return;
    let drag: {
      mode: "select" | "deselect";
      x: number;
      y: number;
      painting: boolean;
      /** the row the press landed on — painted first, so the row you grab is
       *  included in the sweep rather than skipped once the cursor moves off it */
      startId: string | null;
      lastId: string | null;
    } | null = null;

    const rowIdAt = (x: number, y: number): string | null => {
      const target = document.elementFromPoint(x, y);
      const row = target?.closest?.(".hist-row") as HTMLElement | null;
      return row?.dataset.id ?? null;
    };

    const onMove = (e: PointerEvent) => {
      if (!drag) return;
      if (!drag.painting) {
        if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < DRAG_PAINT_THRESHOLD) return;
        drag.painting = true;
        paintedRef.current = true;
        if (drag.mode === "select" && !selectingRef.current) onToggleSelecting();
        // paint the grabbed row first (entering select mode above must not skip it)
        if (drag.startId) {
          drag.lastId = drag.startId;
          onPaint(drag.startId, drag.mode === "select");
        }
      }
      e.preventDefault();
      const id = rowIdAt(e.clientX, e.clientY);
      if (id && id !== drag.lastId) {
        drag.lastId = id;
        onPaint(id, drag.mode === "select");
      }
    };

    const end = () => {
      const painted = drag?.painting === true;
      drag = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      // The click that follows pointerup fires before this macrotask, so the
      // swallow above still sees the flag; clearing it here stops a sweep that
      // ended outside the list from eating the NEXT unrelated click.
      if (painted) setTimeout(() => (paintedRef.current = false), 0);
    };

    const onDown = (e: PointerEvent) => {
      if (e.pointerType !== "mouse" || deletingRef.current) return;
      const target = e.target as HTMLElement;
      // never start a sweep on a control that is not a row body
      if (target.closest(".hist-trash, .rail-sel-btn, .rail-sel-del, .rail-sel-enter")) return;
      const mode = e.button === 2 ? "deselect" : e.button === 0 ? "select" : null;
      if (!mode) return;
      // nothing to deselect unless we are already selecting
      if (mode === "deselect" && !selectingRef.current) return;
      paintedRef.current = false;
      drag = { mode, x: e.clientX, y: e.clientY, painting: false, startId: rowIdAt(e.clientX, e.clientY), lastId: null };
      window.addEventListener("pointermove", onMove, { passive: false });
      window.addEventListener("pointerup", end);
      window.addEventListener("pointercancel", end);
    };

    // the history list is the only surface where right-drag is meaningful, so
    // suppress the native context menu there and let the sweep use the button
    const onContext = (e: MouseEvent) => e.preventDefault();

    el.addEventListener("pointerdown", onDown);
    el.addEventListener("contextmenu", onContext);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("contextmenu", onContext);
      end();
    };
  }, [tab, onPaint, onToggleSelecting]);

  return (
    <aside className="console-rail" data-od-id="console-rail" aria-label="Agent console">
      <div className="rail-tabs" role="tablist" aria-label="Console panel">
        {RAIL_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            id={`rail-tab-${t.key}`}
            aria-selected={tab === t.key}
            aria-controls={`rail-panel-${t.key}`}
            tabIndex={tab === t.key ? 0 : -1}
            className="rail-tab"
            onClick={() => onTab(t.key)}
            onKeyDown={(e) => {
              const order = RAIL_TABS.map((x) => x.key);
              const i = order.indexOf(tab);
              let next = -1;
              if (e.key === "ArrowRight") next = (i + 1) % order.length;
              else if (e.key === "ArrowLeft") next = (i - 1 + order.length) % order.length;
              else return;
              e.preventDefault();
              onTab(order[next]);
              document.getElementById(`rail-tab-${order[next]}`)?.focus();
            }}
          >
            <span className="rail-tab-icon">{t.icon}</span>
            <span className="rail-tab-label">{t.label}</span>
          </button>
        ))}
        {onClose ? (
          <button type="button" className="rail-close" aria-label="Hide console panel" onClick={onClose}>
            <IconClose />
          </button>
        ) : null}
      </div>

      {tab === "telemetry" ? (
        <div className="rail-body" role="tabpanel" id="rail-panel-telemetry" aria-labelledby="rail-tab-telemetry">
          <section className="rail-sec" data-od-id="rail-swarm">
            <h3 className="rail-h">
              Swarm
              <span className="rail-h-count">
                {swarm.filter((s) => s.state === "working" || s.state === "live").length}/{swarm.length} active
              </span>
            </h3>
            {swarm.length ? (
              <ul className="rail-agents" role="list">
                {swarm.map(({ agent: a, state, active }) => (
                  <li key={a.id}>
                    <button
                      type="button"
                      className={`rail-agent${active ? " is-active" : ""}`}
                      aria-current={active ? "true" : undefined}
                      onClick={() => !active && openAgent(a.id)}
                      title={active ? `${a.name} — this conversation` : `Open ${a.name}`}
                    >
                      <StatusLamp state={state} />
                      <span className="ra-name">{a.name}</span>
                      <span className="ra-role">{a.role || "—"}</span>
                      <span className="ra-state" data-state={state}>
                        {stateLabel(state)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="rail-empty">No agents registered.</p>
            )}
          </section>

          <section className="rail-sec" data-od-id="rail-tasks">
            <h3 className="rail-h">Current tasks</h3>
            {tasks.length ? (
              <ul className="rail-tasks" role="list">
                {tasks.map((t) => (
                  <li className="rail-task" key={t.id} data-state={t.state}>
                    <span className="rt-glyph" aria-hidden />
                    <span className="rt-body">
                      <span className="rt-label" title={t.label}>
                        {t.label}
                      </span>
                      {t.detail ? <span className="rt-detail">{t.detail}</span> : null}
                    </span>
                    <span className="rt-state">{t.state}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="rail-empty">
                Nothing in flight. {agent.name} is idle.
              </p>
            )}
          </section>

          <section className="rail-sec" data-od-id="rail-subagents">
            <h3 className="rail-h">
              Sub-agents
              {subagents.length ? (
                <span className="rail-h-count">
                  {subagents.filter((s) => s.status === "running").length}/{subagents.length} running
                </span>
              ) : null}
            </h3>
            {subagents.length ? (
              <ul className="rail-subs" role="list">
                {subagents.map((s) => (
                  <li className="rail-sub" key={s.id} data-state={s.status}>
                    <span className="rs-mark" aria-hidden />
                    <span className="rs-body">
                      <span className="rs-role" title={s.agent}>
                        {s.agent}
                      </span>
                      <span className="rs-task" title={s.task}>
                        {s.task}
                      </span>
                    </span>
                    <span className="rs-status">
                      {s.status === "running" ? "running" : s.status === "error" ? "failed" : s.duration ?? "done"}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="rail-empty">
                No sub-agents spawned. {agent.name} is working alone.
              </p>
            )}
          </section>

          <section className="rail-sec" data-od-id="rail-activity">
            <h3 className="rail-h">Agent activity</h3>
            {activity.length ? (
              <ul className="rail-activity" role="list">
                {activity.map((a) => (
                  <li className="rail-act" key={a.id} data-tone={a.tone}>
                    <span className="rac-time">{formatClock(a.at)}</span>
                    <span className="rac-text">
                      {a.agent ? <span className="rac-agent">{a.agent}</span> : null}
                      {a.text}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="rail-empty">No execution activity yet this session.</p>
            )}
          </section>

          <section className="rail-sec" data-od-id="rail-growth">
            <h3 className="rail-h">
              Knowledge growth
              <span className="rail-h-count">{growthTotal ? `${growthTotal} nodes` : "—"}</span>
            </h3>
            {growth.length ? (
              <GrowthCurve points={growth} height={96} caption="concept notes created" />
            ) : (
              <p className="rail-empty">— NO DATA · graph not loaded</p>
            )}
          </section>
        </div>
      ) : null}

      {tab === "history" ? (
        <div className="rail-body" role="tabpanel" id="rail-panel-history" aria-labelledby="rail-tab-history">
          <section
            className="rail-sec"
            data-od-id="rail-history"
            ref={histRef}
            // a pointerup that just finished painting a sweep still fires a click;
            // swallow that one click so it never opens a chat or re-toggles a row
            onClickCapture={(e) => {
              if (paintedRef.current) {
                paintedRef.current = false;
                e.preventDefault();
                e.stopPropagation();
              }
            }}
          >
            {selecting ? (
              <div className="rail-h rail-h-select">
                <span className="rail-h-title">
                  Chats
                  <span className="rail-h-count">{selectedIds.size} selected</span>
                </span>
                <span className="rail-sel-actions">
                  <button
                    type="button"
                    className="rail-sel-btn"
                    disabled={!sessions.length || deleting}
                    onClick={onSelectAll}
                  >
                    {allSelected ? "Deselect all" : "Select all"}
                  </button>
                  <button
                    type="button"
                    className="rail-sel-del"
                    disabled={selectedIds.size === 0 || deleting}
                    onClick={onBulkDelete}
                  >
                    {deleting ? `Deleting ${selectedIds.size}…` : `Delete ${selectedIds.size}`}
                  </button>
                </span>
              </div>
            ) : (
              <h3 className="rail-h">
                <span className="rail-h-title">
                  Chats
                  <span className="rail-h-count">{sessions.length}</span>
                </span>
                {sessions.length ? (
                  <button type="button" className="rail-sel-enter" onClick={onToggleSelecting}>
                    Select
                  </button>
                ) : null}
              </h3>
            )}
            {bulkError ? (
              <p className="rail-err" role="alert">
                {bulkError}
              </p>
            ) : null}
            {sessions.length ? (
              sessions.map((s) => {
                const selected = selectedIds.has(s.id);
                return (
                  <div
                    key={s.id}
                    data-id={s.id}
                    className={`hist-row${s.id === sessionId ? " is-active" : ""}${selected ? " is-selected" : ""}`}
                  >
                    <button
                      type="button"
                      className="hist-item"
                      aria-pressed={selecting ? selected : undefined}
                      onClick={() => (selecting ? onToggleSession(s.id) : onOpenSession(s.id))}
                      title={selecting ? (selected ? `Deselect "${s.title}"` : `Select "${s.title}"`) : s.title}
                    >
                      {selecting ? (
                        <span className="hist-check" data-on={selected || undefined} aria-hidden>
                          {selected ? <IconCheck /> : null}
                        </span>
                      ) : (
                        <span className="hist-icon">
                          <IconChat />
                        </span>
                      )}
                      <span className="hist-name">
                        <span className="hist-title">{s.title}</span>
                        <span className="hist-meta">
                          {s.messageCount} messages · {relativeTime(s.updatedAt)}
                        </span>
                      </span>
                    </button>
                    {selecting ? null : (
                      <button
                        className="hist-trash"
                        aria-label={`Delete chat: ${s.title}`}
                        title="Delete this chat"
                        onClick={() => onDeleteSession(s)}
                      >
                        <IconTrash />
                      </button>
                    )}
                  </div>
                );
              })
            ) : (
              <p className="rail-empty">No saved chats yet.</p>
            )}
          </section>
        </div>
      ) : null}

      {tab === "config" ? (
        <div className="rail-body rail-body-config" role="tabpanel" id="rail-panel-config" aria-labelledby="rail-tab-config">
          {configSlot}
        </div>
      ) : null}

      <div className="rail-foot">
        <button
          type="button"
          className="rail-foot-btn"
          disabled={!agent.currentNode}
          onClick={() => agent.currentNode && onFocusGraph(agent.currentNode)}
        >
          <IconGraph />
          <span>{agent.currentNode ? `Focus ${agent.currentNode}` : "No linked node"}</span>
        </button>
        <span className="rail-foot-heart" title="Agent heartbeat">
          <IconClock />
          <span>{agent.name} · {formatAge(feed.data?.agents[agent.id]?.heartbeatAgeMs ?? null)}</span>
        </span>
      </div>
    </aside>
  );
}

/** "10:25" — the wall-clock time of an activity, in the operator's locale. */
function formatClock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function relativeTime(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}
