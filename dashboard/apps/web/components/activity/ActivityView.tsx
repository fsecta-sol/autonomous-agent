"use client";

import { useMemo, useState } from "react";
import { useWorkspace } from "@/components/providers/workspace";
import { ActivityEvent } from "./ActivityEvent";
import { GROWTH_SERIES } from "@/lib/store";
import type { ActivityCategory } from "@dashboard/shared";

type GrowthKind = "nodes" | "relationships" | "sources";

const GROWTH_MODES: { key: GrowthKind; label: string }[] = [
  { key: "nodes", label: "Nodes" },
  { key: "relationships", label: "Relationships" },
  { key: "sources", label: "Sources" },
];

const FILTERS: { key: "all" | ActivityCategory; label: string }[] = [
  { key: "all", label: "All" },
  { key: "knowledge", label: "Knowledge" },
  { key: "relationships", label: "Relationships" },
  { key: "agents", label: "Agents" },
  { key: "pipelines", label: "Pipelines" },
  { key: "reviews", label: "Reviews" },
];

export function ActivityView() {
  const { activityDays, pipelines } = useWorkspace();
  const [growth, setGrowth] = useState<GrowthKind>("nodes");
  const [filter, setFilter] = useState<"all" | ActivityCategory>("all");
  const [dayKey, setDayKey] = useState(activityDays[0]?.key ?? "today");

  const day = activityDays.find((d) => d.key === dayKey) ?? activityDays[0];

  const shown = useMemo(() => {
    if (!day) return [];
    return day.log.filter((item) => {
      if (filter === "all") return true;
      return item.category === filter;
    });
  }, [day, filter]);

  const stats = useMemo(() => {
    const up = day ? day.log.filter((x) => !x.idle).length : 0;
    const total = day?.log.length ?? 0;
    return { up, idle: total - up };
  }, [day]);

  const series = GROWTH_SERIES[growth];
  const max = Math.max(...series.values) * 1.1;
  const linePath = series.values
    .map((v, i) => `${i ? "L" : "M"}${i * 50},${(100 - (v / max) * 100).toFixed(2)}`)
    .join(" ");
  const areaPath = `${linePath} L100,100 L0,100 Z`;

  return (
    <section className="view active" data-od-id="view-activity">
      <div className="panel-header">
        <h2>Activity</h2>
        <div className="graph-meta">
          <span className="legend-item">
            <span className="h-dot" />
            LIVE
          </span>
          <span className="dot">·</span>
          <span>
            {day?.label ?? "Today"} · {stats.up} update{stats.up === 1 ? "" : "s"} · {stats.idle} idle check
            {stats.idle === 1 ? "" : "s"}
          </span>
        </div>
      </div>

      <div className="activity-console">
        <div className="activity-overview">
          <section className="activity-module">
            <div className="act-growth-head">
              <span className="act-label">Knowledge growth</span>
              <div className="act-modes">
                {GROWTH_MODES.map((m) => (
                  <button
                    className="act-mode"
                    key={m.key}
                    type="button"
                    aria-pressed={growth === m.key}
                    onClick={() => setGrowth(m.key)}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="act-metric">
              {series.count} <small>{series.unit}</small>
            </div>
            <div className="act-sub">{series.delta}</div>
            <div className="act-chart">
              <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                <path className="chart-area" d={areaPath} />
                <path className="chart-line" d={linePath} />
              </svg>
            </div>
            <div className="act-axis">
              <span>Jun 2026</span>
              <span>Jul</span>
              <span>Aug</span>
            </div>
          </section>

          <section className="activity-module">
            <span className="act-label">Knowledge velocity</span>
            <div className="act-metric">
              +18 <small>new nodes / week</small>
            </div>
            <div className="act-sub">+64 relationships · +11 sources</div>
            <svg className="act-spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true">
              <path d="M0 24 L14 20 L28 22 L42 15 L57 17 L71 9 L85 13 L100 4" />
            </svg>
          </section>

          <section className="activity-module">
            <span className="act-label">Graph health</span>
            <div className="act-health">
              <HealthRow label="Validated" value="94%" pct={94} />
              <HealthRow label="Confidence" value="91%" pct={91} />
              <HealthRow label="Orphaned" value="48" pct={19} />
            </div>
          </section>
        </div>

        <section className="activity-section">
          <div className="activity-section-head">
            <h3>Autonomous processes</h3>
            <p>last execution and current state</p>
          </div>
          <div className="pipeline-list">
            {pipelines.map((p) => {
              const active = p.state !== "idle";
              return (
                <div className="pipeline-row" key={p.id}>
                  <i className={`pipeline-state ${active ? "is-active" : ""}`} />
                  <div>
                    <div className="pipeline-name">{p.name}</div>
                    <span className="pipeline-meta">
                      {p.agent} · {p.cadence} · last {p.last}
                    </span>
                  </div>
                  <div className="pipeline-status">{p.state}</div>
                </div>
              );
            })}
          </div>
        </section>

        <section className="activity-section">
          <div className="activity-section-head">
            <h3>Detailed history</h3>
            <p>Provenance, agent, and graph activity</p>
            <div className="activity-filters">
              {FILTERS.map((f) => (
                <button
                  type="button"
                  className="activity-filter"
                  key={f.key}
                  aria-pressed={filter === f.key}
                  onClick={() => setFilter(f.key)}
                >
                  {f.label}
                </button>
              ))}
              <select className="activity-date" aria-label="Activity date" value={dayKey} onChange={(e) => setDayKey(e.target.value)}>
                {activityDays.map((d) => (
                  <option value={d.key} key={d.key}>
                    {d.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="activity-log">
            {shown.length ? (
              shown.map((item) => <ActivityEvent key={item.id} item={item} />)
            ) : (
              <div className="activity-empty">No activity matches this filter.</div>
            )}
          </div>
        </section>
      </div>
    </section>
  );
}

function HealthRow({ label, value, pct }: { label: string; value: string; pct: number }) {
  return (
    <div className="health-row">
      <span>{label}</span>
      <span>{value}</span>
      <div className="health-bar">
        <i style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
