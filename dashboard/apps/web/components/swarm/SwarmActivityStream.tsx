"use client";

import { useWorkspace } from "@/components/providers/workspace";
import type { SwarmActivityItem } from "@dashboard/shared";

const AGENT_SLUG: Record<string, string> = {
  Kai: "kai",
  Vale: "vale",
  Tally: "tally",
  Moss: "moss",
  Wick: "wick",
  Echo: "echo",
};

/** Renders **bold** spans and returns safe React nodes. */
function renderText(text: string): React.ReactNode {
  return text.split(/(\*\*.+?\*\*)/g).map((part, i) => {
    const m = part.match(/^\*\*(.+?)\*\*$/);
    if (m) return <b key={i}>{m[1]}</b>;
    return <span key={i}>{part}</span>;
  });
}

interface SwarmActivityStreamProps {
  /** "swarm" fills the panel on the index view; "rail" is the compact sidebar variant */
  variant?: "swarm" | "rail";
}

export function SwarmActivityStream({ variant = "rail" }: SwarmActivityStreamProps) {
  const { swarmActivity, feedLive, dismissActivity, focusNodeByTitle } = useWorkspace();

  return (
    <div
      className={`swarm-activity ${variant === "swarm" ? "swarm-activity-panel" : ""}`}
      data-od-id="swarm-activity"
      aria-label="Swarm activity stream"
    >
      <div className="fa-head">
        <h3>Swarm activity</h3>
        <span className="grp-tag" title="This stream is synthesized locally until the agent runtime feed is wired">
          sample
        </span>
        <span className={`fa-live ${feedLive ? "" : "paused"}`}>
          <span className="fa-live-dot" />
          {feedLive ? "Live" : "Paused"}
        </span>
      </div>
      <div className="fa-scroll" role="list" aria-label="Recent agent actions">
        {swarmActivity.map((item) => (
          <ActivityRow
            key={item.id}
            item={item}
            onOpen={() => item.node && focusNodeByTitle(item.node)}
            onDismiss={() => dismissActivity(item.id)}
          />
        ))}
        {!swarmActivity.length ? (
          <div className="activity-empty">No agent activity in this session yet.</div>
        ) : null}
      </div>
    </div>
  );
}

function ActivityRow({
  item,
  onOpen,
  onDismiss,
}: {
  item: SwarmActivityItem;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  const ag = AGENT_SLUG[item.agent] ?? item.agent.toLowerCase();
  // The row opens the touched concept in the graph. It carries the pointer
  // affordance but stays a passive list item: the open action is a real button
  // so keyboard and AT users reach it, and the row's own click is a convenience
  // shortcut rather than the only path.
  return (
    <div className="fa-item" role="listitem">
      <span className="fa-dot" data-ag={ag} aria-hidden="true" />
      <button
        className="fa-body"
        type="button"
        aria-label={`Open ${item.node || "concept"} in the graph`}
        disabled={!item.node}
        onClick={onOpen}
      >
        <span className="fa-text">{renderText(item.text)}</span>
      </button>
      <span className="fa-time">{item.time}</span>
      <span className="fa-actions">
        <button
          className="fa-btn fa-x"
          type="button"
          aria-label="Dismiss this activity"
          onClick={onDismiss}
        >
          Dismiss
        </button>
      </span>
    </div>
  );
}
