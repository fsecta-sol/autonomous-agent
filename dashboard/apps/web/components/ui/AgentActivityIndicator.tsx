"use client";

type AgentActivityIndicatorProps = {
  /** compact dot-only signal vs. labelled pre-stream state */
  variant?: "signal" | "labelled";
  /** shown beside the dots in the labelled variant (e.g. "Kai is working") */
  label?: string;
  /** secondary line in the labelled variant (e.g. "Composing the answer…") */
  detail?: string;
};

/**
 * The live-generation signal. A compact horizontal cluster of five particles
 * that breathes left → right in a staggered 1.2 s loop — opacity, scale and a
 * 1 px vertical nudge — so the agent reads as actively streaming rather than
 * frozen on a terminal caret. Shown underneath the in-flight assistant text
 * while `phase` is generating/reasoning/thinking, removed with a fade when the
 * turn settles. No timers: the caller mounts/unmounts from the real stream
 * state (`sending`/`phase` in AgentDetail).
 */
export function AgentActivityIndicator({
  variant = "signal",
  label,
  detail,
}: AgentActivityIndicatorProps) {
  if (variant === "labelled") {
    return (
      <div className="agent-signal agent-signal--labelled" role="status" aria-live="polite" aria-label={detail ?? label ?? "Agent is working"}>
        <span className="agent-signal-dots" aria-hidden>
          <i style={{ ["--i" as string]: 0 }} />
          <i style={{ ["--i" as string]: 1 }} />
          <i style={{ ["--i" as string]: 2 }} />
          <i style={{ ["--i" as string]: 3 }} />
          <i style={{ ["--i" as string]: 4 }} />
        </span>
        <span className="agent-signal-text">
          {label ? <span className="agent-signal-label">{label}</span> : null}
          {detail ? <span className="agent-signal-detail">{detail}</span> : null}
        </span>
      </div>
    );
  }

  return (
    <div className="agent-signal" role="status" aria-live="polite" aria-label="Generating response">
      <span className="agent-signal-dots" aria-hidden>
        <i style={{ ["--i" as string]: 0 }} />
        <i style={{ ["--i" as string]: 1 }} />
        <i style={{ ["--i" as string]: 2 }} />
        <i style={{ ["--i" as string]: 3 }} />
        <i style={{ ["--i" as string]: 4 }} />
      </span>
    </div>
  );
}
