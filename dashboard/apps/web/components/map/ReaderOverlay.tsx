"use client";

import { useMemo } from "react";
import { useWorkspace } from "@/components/providers/workspace";
import { renderMarkdown } from "@/lib/markdown";

/**
 * Full-panel markdown reader. Opens over the graph column when a doc, note,
 * analysis or inbox file is opened. Wikilinks become clickable and focus the
 * matching concept in the graph.
 */
export function ReaderOverlay() {
  const { reader, closeReader, focusNodeByTitle, graph } = useWorkspace();

  const html = useMemo(() => (reader ? renderMarkdown(reader.body, { allowRawHtml: true }) : ""), [reader]);

  if (!reader) return null;

  return (
    <div className="reader open" data-od-id="reader">
      <div className="reader-head">
        <span className="rd-kind">{reader.kind === "ana" ? "analysis" : reader.kind}</span>
        <span className="rd-title">{reader.title}</span>
        <button className="rd-close" aria-label="Close reader" onClick={closeReader}>
          ×
        </button>
      </div>
      <div className="reader-body">
        <div className="rd-scroll">
          <div
            className="rd-doc"
            onClick={(e) => {
              const el = (e.target as HTMLElement).closest(".rd-wiki");
              if (!el || !graph) return;
              const title = el.textContent ?? "";
              if (graph.nodes.some((n) => n.label === title)) {
                closeReader();
                focusNodeByTitle(title);
              }
            }}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </div>
      </div>
    </div>
  );
}
