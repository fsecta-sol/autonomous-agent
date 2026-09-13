"use client";

import { useMemo } from "react";
import { useWorkspace } from "@/components/providers/workspace";
import { INBOX_PENDING, REVIEW_TITLES } from "@/lib/store";

export function HealthStrip() {
  const { agents, graph, activityDays, pipelines, feedLive, setFeedLive, setView } = useWorkspace();

  const stats = useMemo(() => {
    const working = agents.filter((a) => a.status === "working" || a.status === "analysing").length;
    const idle = agents.filter((a) => a.status === "idle").length;
    const tasked = agents.filter((a) => a.status === "pending").length;
    const nodes = graph?.nodes.length ?? 0;
    const edges = graph?.edges.length ?? 0;
    const today = activityDays[0]?.log ?? [];
    const updates = today.filter((x) => !x.idle).length;
    const idleChecks = today.length - updates;
    const active = pipelines.filter((p) => p.state !== "idle").length;
    const queued = pipelines.length - active;
    return { working, idle, tasked, nodes, edges, updates, idleChecks, active, queued };
  }, [agents, graph, activityDays, pipelines]);

  return (
    <div className="health-strip" data-od-id="health-strip" aria-label="Swarm telemetry">
      <button
        type="button"
        className="hs-cell"
        data-od-id="hs-growth"
        title={`Swarm: ${agents.map((a) => `${a.name} (${a.status})`).join(" · ")}`}
        onClick={() => setView("swarm")}
      >
        <span className="hs-label">Swarm</span>
        <span className="hs-num">{agents.length} agents</span>
        <span className="hs-sub">
          {stats.working} working · {stats.idle} idle · {stats.tasked} tasked
        </span>
        <span className="hs-dot is-live" />
      </button>
      <button
        type="button"
        className="hs-cell"
        data-od-id="hs-quality"
        title={`${stats.nodes} knowledge nodes · ${stats.edges} relationships`}
        onClick={() => setView("graph")}
      >
        <span className="hs-label">Knowledge</span>
        <span className="hs-num">{stats.nodes} nodes</span>
        <span className="hs-sub">{stats.edges} links · +{stats.nodes > 0 ? 37 : 0} today</span>
        <span className="hs-dot is-live" />
      </button>
      <button
        type="button"
        className="hs-cell hg-pipeline"
        data-od-id="hs-pipeline"
        title={`${stats.active} active runs · ${stats.queued} queued · ${stats.updates} updates today · ${INBOX_PENDING.length} pending`}
        onClick={() => setView("activity")}
      >
        <span className="hs-label">Pipeline</span>
        <span className="hs-num">
          {stats.active} active · {stats.queued} queued
        </span>
        <span className="hs-sub">{stats.updates} runs today</span>
        <span className="hs-dot is-live" />
      </button>
      <button
        type="button"
        className={`hs-cell hg-review ${REVIEW_TITLES.length > 0 ? "is-attn" : ""}`}
        data-od-id="hs-review"
        title={`94% of new relationships validated this week · ${REVIEW_TITLES.length} notes still need human review`}
        onClick={() => setView("graph")}
      >
        <span className="hs-label">Quality</span>
        <span className="hs-num">94%</span>
        <span className="hs-sub">validated</span>
        <span className="hs-dot is-live" />
      </button>
      <div className="feed-toggle" data-od-id="feed-toggle">
        <button
          type="button"
          className="feed-btn"
          aria-pressed={feedLive}
          data-feed="live"
          title={feedLive ? "Live feed — click to pause" : "Feed paused — click to resume"}
          onClick={() => setFeedLive(!feedLive)}
        >
          <span className="fb-dot" aria-hidden="true" />
          <span className="fb-label-live">Live</span>
          <span className="fb-label-off">Paused</span>
        </button>
      </div>
    </div>
  );
}
