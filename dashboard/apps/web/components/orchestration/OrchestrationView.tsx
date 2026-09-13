"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ORCH_COLS,
  ORCH_LANES,
  ORCH_RUNS,
  ORCH_TASKS,
  type OrchCol,
  type OrchTask,
} from "@/lib/orchestration";
import { IconBolt, IconCheck, IconClose, IconDot } from "@/components/ui/icons";

const STATUS_PILL: Record<OrchCol, { cls: string; label: string }> = {
  queued: { cls: "s-idle", label: "Queued" },
  planning: { cls: "s-paused", label: "Planning" },
  running: { cls: "s-working", label: "Running" },
  review: { cls: "s-blocked", label: "In review" },
  done: { cls: "s-working", label: "Done" },
};

const STEPS = ["Gather inputs", "Execute", "Validate output", "Hand off"];
const STEP_IDX: Record<OrchCol, number> = { queued: 0, planning: 1, running: 2, review: 3, done: 4 };

function initials(n: string): string {
  return (n.charAt(0) + (n.charAt(1) || "")).toUpperCase();
}

export function OrchestrationView() {
  const [tasks, setTasks] = useState<OrchTask[]>(ORCH_TASKS);
  const [run, setRun] = useState<"digest" | "refund" | "docs">("digest");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const lastFocus = useRef<HTMLElement | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  }, []);

  const runTasks = useMemo(() => tasks.filter((t) => t.run === run), [tasks, run]);
  const selected = selectedId ? tasks.find((t) => t.id === selectedId) ?? null : null;

  const closeDrawer = useCallback(() => {
    setSelectedId(null);
    if (lastFocus.current) {
      lastFocus.current.focus();
      lastFocus.current = null;
    }
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (modalOpen) setModalOpen(false);
      else if (selectedId) closeDrawer();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [closeDrawer, modalOpen, selectedId]);

  const taskAction = (act: string) => {
    if (!selected) return;
    const setCol = (col: OrchCol, msg: string) => {
      setTasks((prev) => prev.map((t) => (t.id === selected.id ? { ...t, col } : t)));
      showToast(msg);
    };
    if (act === "promote") setCol("running", `${selected.id.toUpperCase()} promoted to Running`);
    else if (act === "approve") setCol("done", `${selected.id.toUpperCase()} approved`);
    else if (act === "rerun") setCol("running", `Re-running ${selected.id.toUpperCase()}`);
    else if (act === "skip") showToast("Step skipped");
    else if (act === "reassign") showToast("Reassignment queued");
    else if (act === "viewout") showToast("Opening output stream…");
  };

  const dispatch = (data: { tpl: string; note: string; prio: string }) => {
    const title = data.note || `${data.tpl.replace(/ pipeline$/, "")} — new run`;
    setTasks((prev) => [
      ...prev,
      { id: `x${Date.now().toString().slice(-5)}`, run, col: "queued", title, agent: "Unassigned", tags: ["new", data.prio.toLowerCase()], eta: "—", deps: 0 },
    ]);
    setModalOpen(false);
    showToast(`Run dispatched — ${ORCH_RUNS[run]}`);
  };

  return (
    <section className="view active" data-od-id="view-orchestration">
      <div className="orch-index">
        <div className="orch-head">
          <div>
            <h2>Orchestration</h2>
            <div className="orch-sub">3 workflows · concurrency 8 · demo data</div>
          </div>
          <button className="orch-dispatch" data-od-id="orch-dispatch" type="button" onClick={() => setModalOpen(true)}>
            <IconBolt />
            Dispatch run
          </button>
        </div>

        <div className="orch-rtabs" role="tablist" aria-label="Active runs">
          {(Object.keys(ORCH_RUNS) as Array<"digest" | "refund" | "docs">).map((r) => (
            <button
              role="tab"
              key={r}
              aria-selected={run === r}
              onClick={() => {
                setRun(r);
                setSelectedId(null);
              }}
            >
              {ORCH_RUNS[r]}
            </button>
          ))}
        </div>

        <div className="orch-board-grid" data-od-id="orch-board">
          {ORCH_COLS.map(([col, label]) => {
            const cards = runTasks.filter((t) => t.col === col);
            return (
              <div className="orch-col" key={col}>
                <h2>
                  {label} <span>{cards.length}</span>
                </h2>
                <div className="orch-cards">
                  {cards.map((t) => (
                    <TaskCard
                      key={t.id}
                      task={t}
                      selected={selectedId === t.id}
                      onSelect={(el) => {
                        lastFocus.current = el;
                        setSelectedId(t.id);
                      }}
                    />
                  ))}
                  {!cards.length ? <div className="orch-colempty">No tasks</div> : null}
                </div>
              </div>
            );
          })}
        </div>

        <div data-od-id="orch-timeline">
          <h2 className="orch-tl-h">Live agent timeline · last 60 min</h2>
          <div className="orch-tlwrap">
            <div className="orch-tlaxis">
              <span>-60m</span>
              <span>-45m</span>
              <span>-30m</span>
              <span>-15m</span>
              <span>now</span>
            </div>
            {ORCH_LANES.map((lane) => (
              <div className="orch-lane" key={lane.ln}>
                <span className="orch-ln">{lane.ln}</span>
                <div className="orch-track">
                  {lane.blocks.map((b, i) => (
                    <span className={`orch-blk ${b.k}`} key={i} style={{ left: `${b.l}%`, width: `${b.w}%` }} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className={`orch-scrim ${selectedId ? "on" : ""}`} onClick={closeDrawer} />
      <aside
        className={`orch-drawer ${selectedId ? "on" : ""}`}
        data-od-id="orch-task-panel"
        aria-hidden={!selectedId}
        aria-label="Task detail"
      >
        {selected ? <TaskDrawerContent task={selected} onAction={taskAction} onClose={closeDrawer} /> : null}
      </aside>

      <div
        className={`orch-modal ${modalOpen ? "on" : ""}`}
        data-od-id="orch-dispatch-dialog"
        role="dialog"
        aria-modal="true"
        aria-hidden={!modalOpen}
        aria-labelledby="orch-modal-t"
        onClick={(e) => {
          if (e.target === e.currentTarget) setModalOpen(false);
        }}
      >
        <div className="orch-sheet" role="document">
          <h2 id="orch-modal-t">Dispatch a run</h2>
          <DispatchForm onCancel={() => setModalOpen(false)} onSubmit={dispatch} />
        </div>
      </div>

      <div className={`orch-toast ${toast ? "on" : ""}`} role="status" aria-live="polite">
        {toast}
      </div>
    </section>
  );
}

function TaskCard({ task, selected, onSelect }: { task: OrchTask; selected: boolean; onSelect: (el: HTMLButtonElement) => void }) {
  return (
    <button
      className="orch-tcard"
      aria-pressed={selected}
      onClick={(e) => onSelect(e.currentTarget)}
    >
      <span className="orch-tt">{task.title}</span>
      <span className="orch-tags">
        {task.tags.map((x) => (
          <span className="orch-tg" key={x}>
            {x}
          </span>
        ))}
      </span>
      <span style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <span className="orch-who">
          <span className="orch-mini">{initials(task.agent)}</span>
          {task.agent}
        </span>
        <span style={{ fontFamily: "var(--font-plex-mono), monospace", fontSize: 10, color: "var(--muted)" }}>{task.eta}</span>
      </span>
      {task.deps > 0 ? (
        <span className={`orch-tdeps ${task.blocked ? "bad" : ""}`}>
          {task.deps} {task.deps > 1 ? "deps" : "dep"} · {task.blocked ? "blocked" : "met"}
        </span>
      ) : null}
    </button>
  );
}

function TaskDrawerContent({ task, onAction, onClose }: { task: OrchTask; onAction: (a: string) => void; onClose: () => void }) {
  const cm = STATUS_PILL[task.col];
  const checked = STEP_IDX[task.col];
  const primary =
    task.col === "review"
      ? { act: "approve", label: "Approve & continue" }
      : task.col === "done"
        ? { act: "rerun", label: "Re-run task" }
        : task.col === "running"
          ? { act: "viewout", label: "View live output" }
          : { act: "promote", label: "Promote to running" };

  return (
    <>
      <div className="orch-dhead">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
            <strong style={{ fontSize: 14 }}>{task.title}</strong>
            <span className={`orch-pill ${cm.cls}`}>
              <i className="dot" />
              {cm.label}
            </span>
          </div>
          <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>
            {ORCH_RUNS[task.run]} · task {task.id.toUpperCase()}
          </div>
        </div>
        <button className="icon-btn" data-act="close" aria-label="Close panel" onClick={onClose}>
          <IconClose />
        </button>
      </div>
      <div className="orch-dbody">
        <div>
          <span className="orch-sec-k" style={{ margin: 0 }}>
            Assigned
          </span>
          <span className="orch-who">
            <span className="orch-mini">{initials(task.agent)}</span>
            {task.agent}{" "}
            <button
              data-act="reassign"
              style={{ color: "var(--accent)", textDecoration: "underline", fontSize: 12 }}
              onClick={() => onAction("reassign")}
            >
              reassign
            </button>
          </span>
        </div>
        <div>
          <div className="orch-sec-k">Dependencies</div>
          {task.deps ? (
            Array.from({ length: task.deps }).map((_, i) => {
              const bad = task.blocked && i === task.deps - 1;
              return (
                <span className={`orch-dpill ${bad ? "wait" : "met"}`} key={i}>
                  {bad ? <IconDot /> : <IconCheck />}
                  {bad ? "waiting" : "met"} · upstream {i + 1}
                </span>
              );
            })
          ) : (
            <span style={{ fontSize: 12, color: "var(--muted)" }}>No upstream dependencies</span>
          )}
        </div>
        <div>
          <div className="orch-sec-k">Steps</div>
          <div className="orch-steps">
            {STEPS.map((st, i) => {
              const cl = i < checked ? "done" : i === checked && task.col !== "done" ? "now" : "";
              return (
                <div className={`orch-step ${cl}`} key={st}>
                  <span className="bx">{i < checked ? <IconCheck /> : null}</span>
                  {st}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <div className="orch-dfoot">
        <button className="orch-btn orch-btn-primary" data-act={primary.act} onClick={() => onAction(primary.act)}>
          {primary.label}
        </button>
        <button className="orch-btn" data-act="skip" onClick={() => onAction("skip")}>
          Skip step
        </button>
        <button className="orch-btn orch-btn-ghost" data-act="viewout" onClick={() => onAction("viewout")}>
          View output
        </button>
      </div>
    </>
  );
}

function DispatchForm({
  onCancel,
  onSubmit,
}: {
  onCancel: () => void;
  onSubmit: (d: { tpl: string; note: string; prio: string }) => void;
}) {
  const [tpl, setTpl] = useState("Research digest pipeline");
  const [conc, setConc] = useState(8);
  const [prio, setPrio] = useState("Normal");
  const [note, setNote] = useState("");

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ tpl, note: note.trim(), prio });
      }}
    >
      <div className="f">
        <label htmlFor="m-tpl">Workflow template</label>
        <select id="m-tpl" value={tpl} onChange={(e) => setTpl(e.target.value)}>
          <option>Research digest pipeline</option>
          <option>Refund sweep</option>
          <option>Docs refresh</option>
          <option>Custom pipeline</option>
        </select>
      </div>
      <div className="f">
        <label htmlFor="m-conc">Concurrency</label>
        <div className="orch-rng">
          <input id="m-conc" type="range" min={1} max={16} value={conc} onChange={(e) => setConc(+e.target.value)} />
          <b>{conc}</b>
        </div>
      </div>
      <div className="f">
        <label>Priority</label>
        <div className="orch-seg">
          {["Low", "Normal", "High"].map((p) => (
            <label key={p}>
              <input type="radio" name="prio" value={p} checked={prio === p} onChange={() => setPrio(p)} />
              {p}
            </label>
          ))}
        </div>
      </div>
      <div className="f">
        <label htmlFor="m-note">Brief</label>
        <textarea
          id="m-note"
          placeholder="Start your request, and let the swarm handle the rest…"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>
      <div className="orch-foot">
        <button type="button" className="orch-btn" data-act="cancel" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="orch-btn orch-btn-primary">
          Start run
        </button>
      </div>
    </form>
  );
}
