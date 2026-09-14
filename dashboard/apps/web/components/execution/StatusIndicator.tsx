import type { ActivityStatus } from "@/lib/execution";

/**
 * The small circular node on the execution spine. Its ring reflects status —
 * a rotating arc while running, a quiet solid dot when settled, an error dot
 * when it failed. The glyph is a data mark, so it is allowed to be a circle
 * (the one shape the design system reserves for data, not chrome).
 */
export function StatusIndicator({ status }: { status: ActivityStatus }) {
  return (
    <span
      className="ax-node"
      data-state={status}
      role="img"
      aria-label={status === "running" ? "running" : status === "error" ? "failed" : "complete"}
    />
  );
}
