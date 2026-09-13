"use client";

import { useWorkspace } from "@/components/providers/workspace";
import type { ActivityEvent as ActivityEventType } from "@dashboard/shared";

/**
 * One operational log row. Wikilinks in the text are clickable and focus the
 * matching concept in the graph; the flag chip marks a review state.
 */
export function ActivityEvent({ item }: { item: ActivityEventType }) {
  const { focusNodeByTitle, graph } = useWorkspace();

  const parts = item.text.split(/(\[\[.+?\]\])/g);

  return (
    <div className="activity-event">
      <span className="activity-time">{item.time}</span>
      <span className="activity-agent">{item.agent}</span>
      <div className="activity-event-text">
        {parts.map((part, i) => {
          const m = part.match(/^\[\[(.+?)\]\]$/);
          if (m) {
            const title = m[1];
            const exists = graph?.nodes.some((n) => n.label === title) ?? false;
            return (
              <button
                key={i}
                type="button"
                className="cite"
                onClick={() => exists && focusNodeByTitle(title)}
              >
                [{title}]
              </button>
            );
          }
          return <span key={i}>{part}</span>;
        })}
        {item.flag ? <span className="flag-inline">{item.flag}</span> : null}
      </div>
      <span className="activity-event-meta">{item.provenance}</span>
    </div>
  );
}
