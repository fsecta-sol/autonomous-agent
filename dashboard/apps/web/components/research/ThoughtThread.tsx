"use client";

import { useEffect, useRef, useState } from "react";
import { useWorkspace } from "@/components/providers/workspace";
import { IconArrowUp, IconChevronLeft } from "@/components/ui/icons";
import type { ChatMessage, Thought } from "@dashboard/shared";

interface ThoughtThreadProps {
  thought: Thought;
  running: boolean;
  error: string | null;
  retrying: boolean;
  onBack: () => void;
  onFollowUp: (q: string) => void;
  onRetry: () => void;
}

export function ThoughtThread({ thought, running, error, retrying, onBack, onFollowUp, onRetry }: ThoughtThreadProps) {
  const { focusNodeByTitle, engine } = useWorkspace();
  const [input, setInput] = useState("");
  const threadRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [thought.messages, running]);

  const statusClass = thought.status === "linked" ? "is-linked" : thought.status === "researching" ? "is-running" : "";
  const meta =
    thought.depth +
    " · " +
    thought.stamp +
    " · " +
    (thought.status === "linked"
      ? `linked to ${thought.conn.length} note${thought.conn.length > 1 ? "s" : ""}`
      : thought.status === "researching"
        ? "researching…"
        : "standalone thought");

  const openInGraph = (idx: number) => {
    if (engine) engine.selectAndCenter(idx);
  };

  return (
    <div className="research-detail" data-od-id="research-detail">
      <div className="rd-topbar">
        <button type="button" className="rd-back" data-od-id="rt-back" onClick={onBack}>
          <IconChevronLeft />
          All thoughts
        </button>
        <span className={`rt-status ${statusClass}`}>{thought.status.toUpperCase()}</span>
      </div>
      <div className="rd-thread-head">
        <h2>{thought.text}</h2>
        <div className="rd-meta">{meta}</div>
      </div>
      <div className="rd-thread" ref={threadRef} data-od-id="rd-thread">
        {thought.messages.map((m, i) => (
          <MessageBubble key={i} message={m} onCite={focusNodeByTitle} onOpenInGraph={openInGraph} />
        ))}
        {running ? (
          <div className="message agent">
            <div className="message-head">
              <span className="author agent">Agent</span>
            </div>
            <div className="message-body">
              <span className="cursor-block" />
            </div>
          </div>
        ) : null}
        {error ? (
          <div className="message agent">
            <div className="message-body">
              {error}{" "}
              <button className="auth-retry" type="button" onClick={onRetry} disabled={retrying}>
                {retrying ? "Retrying…" : "Retry"}
              </button>
            </div>
          </div>
        ) : null}
      </div>
      <div className="rd-composer">
        <div className="rc-field">
          <textarea
            className="rc-input"
            rows={1}
            placeholder="Ask a follow-up about this thought…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                const q = input.trim();
                if (q.length >= 2) {
                  setInput("");
                  onFollowUp(q);
                }
              }
            }}
          />
          <div className="rc-row">
            <button
              className="rc-run"
              type="button"
              disabled={input.trim().length < 2}
              onClick={() => {
                const q = input.trim();
                if (q.length >= 2) {
                  setInput("");
                  onFollowUp(q);
                }
              }}
            >
              <IconArrowUp />
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function MessageBubble({
  message,
  onCite,
  onOpenInGraph,
}: {
  message: ChatMessage;
  onCite: (t: string) => void;
  onOpenInGraph: (idx: number) => void;
}) {
  const role = message.role === "you" ? "you" : "agent";
  const parts = message.body.split(/(\[\[.+?\]\])/g);

  return (
    <div className={`message ${role}`}>
      <div className="message-head">
        <span className={`author ${role}`}>{role === "you" ? "You" : message.role === "system" ? "System" : "Agent"}</span>
        {message.stamp ? <span className="timestamp">{message.stamp}</span> : null}
      </div>
      <div className="message-body">
        {parts.map((part, i) => {
          const m = part.match(/^\[\[(.+?)\]\]$/);
          if (m) {
            return (
              <button key={i} type="button" className="cite" onClick={() => onCite(m[1])}>
                [{m[1]}]
              </button>
            );
          }
          return <span key={i}>{part}</span>;
        })}
        {message.links && message.links.length ? (
          <div className="rt-links">↳ {message.links.join("   ·   ")}</div>
        ) : null}
        {typeof message.openIdx === "number" && message.openIdx !== null ? (
          <button type="button" className="rt-open" onClick={() => onOpenInGraph(message.openIdx!)}>
            Open in graph
          </button>
        ) : null}
      </div>
    </div>
  );
}
