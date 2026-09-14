"use client";

import { useMemo } from "react";
import { useWorkspace } from "@/components/providers/workspace";
import { INBOX_PENDING, PROCESSED, PROCESSED_TOTAL, daysBetween } from "@/lib/store";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function shortDay(iso: string): string {
  const p = iso.split("-");
  return `${p[2]} ${MONTHS[+p[1] - 1]}`;
}

export function InboxView() {
  const { openReader } = useWorkspace();

  const pending = useMemo(
    () =>
      INBOX_PENDING.map((name) => {
        const m = name.match(/^(\d{4}-\d{2}-\d{2})-(.+)\.md$/);
        const iso = m ? m[1] : "2026-09-01";
        return { name, iso, age: daysBetween(iso) };
      }),
    [],
  );

  const backlog = useMemo(() => daysBetween("2026-08-18") - daysBetween("2026-09-05"), []);
  const waitingN = INBOX_PENDING.length;

  return (
    <section className="view active" data-od-id="view-inbox">
      <div className="panel-header">
        <h2>Inbox</h2>
        <div className="graph-meta">
          <span className="grp-tag" title="Inbox contents are sample data until the vault reader is wired">
            sample
          </span>
          <span className="dot">·</span>
          <span>{waitingN} pending · last processed 18 Aug · backlog {backlog} days</span>
        </div>
      </div>
      <div className="inbox-grid">
        <div className="inbox-col" data-od-id="inbox-waiting">
          <div className="inbox-col-head">
            <h3>Waiting · knowledge</h3>
            <span className="inbox-col-n">{waitingN}</span>
          </div>
          <div className="inbox-sub">YYYY-MM-DD-&lt;topic&gt;.md · newest first · click to preview</div>
          <div className="inbox-list">
            {pending.map((f) => (
              <button
                className="inbox-file"
                key={f.name}
                onClick={() =>
                  openReader({
                    title: f.name,
                    kind: "inbox",
                    activeKey: null,
                    body:
                      `# ${f.name}\n\nPending in the **knowledge inbox**. Queued for \`process-inbox-knowledge\` (runs every 30 min, wake-gated).\n\n` +
                      `- day: ${f.iso}\n- age: ${f.age} days\n- status: not yet turned into a concept note\n\n` +
                      `The job drains the oldest item first. When it runs, this file becomes one or more notes and moves to \`_processed/${f.iso}/\`.`,
                  })
                }
              >
                <span className="if-name">{f.name}</span>
                <span className="if-day">{shortDay(f.iso)}</span>
                <span className="if-age">{f.age}d</span>
              </button>
            ))}
          </div>
          <div className="inbox-projects-head">
            <h3>Waiting · projects</h3>
            <span className="inbox-col-n">0</span>
          </div>
          <div className="inbox-empty">Projects inbox is empty — nothing waiting. This is the healthy state.</div>
          <div className="inbox-backlog">
            backlog: {backlog} days since last drain (newest pending 05 Sep · newest processed 18 Aug)
          </div>
        </div>

        <div className="inbox-col" data-od-id="inbox-processed">
          <div className="inbox-col-head">
            <h3>Processed</h3>
            <span className="inbox-col-n">{PROCESSED_TOTAL} days</span>
          </div>
          <div className="inbox-sub">_processed/YYYY-MM-DD/ · newest first</div>
          <div className="inbox-list">
            {PROCESSED.map((p) => (
              <div className="inbox-bucket" key={p.date}>
                <span className="ib-date">
                  {shortDay(p.date)} {p.date.slice(0, 4)}
                </span>
                <span className="ib-n">
                  {p.n} item{p.n === 1 ? "" : "s"}
                </span>
              </div>
            ))}
            <div className="inbox-bucket is-more">+ {PROCESSED_TOTAL - PROCESSED.length} older buckets</div>
          </div>
        </div>
      </div>
    </section>
  );
}
