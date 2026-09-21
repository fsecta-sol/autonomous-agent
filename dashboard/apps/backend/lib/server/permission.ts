import type { PermissionMode } from "@dashboard/shared";
export type { PermissionMode };

/**
 * The tool-execution permission policy — one place, so "does this tool need
 * approval?" is answered identically everywhere instead of by `if (bypass)`
 * scattered across routes and the agent service.
 *
 * Two modes:
 *   ask    — a protected action pauses the run for the operator's decision.
 *   bypass — a protected action runs without the interactive gate. This is NOT
 *            an approval: no decision was made. Every other boundary (auth,
 *            tool availability, sandbox, command/path restrictions) still holds;
 *            bypass removes only the interactive step, never a security control.
 *
 * The mode is a property of an EXECUTION (a session), not of the agent: the same
 * agent can run one session on `ask` and another on `bypass`. An agent carries a
 * default; a session may override it. This resolves the two into the one mode a
 * given run should use.
 */

/** Tools whose execution is gated by the permission policy. */
export const PROTECTED_TOOLS: ReadonlySet<string> = new Set(["run_command"]);

/** True when a tool's execution is subject to the ask/bypass policy. */
export function isProtectedTool(name: string): boolean {
  return PROTECTED_TOOLS.has(name);
}

/**
 * The mode a run should use: the session's explicit override when set, else the
 * agent's default, else the conservative `ask`. A null/absent value is "inherit",
 * never "off" — the fallback is always the safe, gated mode.
 */
export function resolvePermissionMode(
  sessionMode: PermissionMode | null | undefined,
  agentMode: PermissionMode | null | undefined,
): PermissionMode {
  return sessionMode ?? agentMode ?? "ask";
}

/** Narrow an unknown value to a PermissionMode, or undefined when it is neither. */
export function asPermissionMode(v: unknown): PermissionMode | undefined {
  return v === "ask" || v === "bypass" ? v : undefined;
}
