/** A tool invocation event surfaced mid-stream. */
export interface ToolStreamEvent {
  type: "tool";
  phase: "start" | "end";
  name: string;
  args?: Record<string, unknown>;
  result?: string;
  error?: boolean;
}

/** One sub-agent spawn of an orchestrator session. */
export interface SpawnEvent {
  id: string | null;
  role: string;
  goal: string;
  status: "running" | "done" | "timed_out" | "error";
  /** epoch ms; absent for spawns read from an old checkpoint (no log entry) */
  startedAt?: number;
  finishedAt?: number | null;
  result?: string | null;
}

/**
 * One recorded SSE envelope for a turn. Persisted on the assistant message so a
 * reload can rebuild the trace by replaying these — the transport is a JSON log,
 * not a live socket. `t` is the wall-clock ms the envelope was observed, so
 * replayed step durations match what the operator saw live.
 */
export interface RunEvent {
  type: "text" | "reasoning" | "tool" | "warning" | "error" | "done" | "interrupt";
  text?: string;
  message?: string;
  phase?: "start" | "end";
  name?: string;
  args?: Record<string, unknown>;
  result?: string;
  error?: boolean;
  id?: string | null;
  tool?: string | null;
  t?: number;
}

/**
 * The execution-trace model for one chat turn.
 *
 * A turn is folded from the real SSE stream into an ordered list of discrete
 * activities rather than paragraphs of chat: thinking boundaries, each tool
 * call (mapped to a domain activity), sub-agent delegation branches, and the
 * final answer. The reducer here is pure so the same model can later be driven
 * by any event source — the shape is the contract, not the transport.
 *
 * "Thinking" carries only a high-level, safe summary of what the agent is
 * doing — never the model's private reasoning text. Raw reasoning stays in the
 * message's own collapsed Reasoning block when the operator enables it.
 */

export type ActivityKind =
  | "thinking"
  | "search-web"
  | "search-vault"
  | "search-data"
  | "read"
  | "plan"
  | "inspect"
  | "run-code"
  | "delegate"
  | "validate"
  | "output"
  | "answer"
  | "tool";

export type ActivityStatus = "running" | "done" | "error";

/** One concurrently-running sub-agent under a delegation step. */
export interface ActivityBranch {
  id: string;
  /** the sub-agent's role, e.g. "source scout" */
  agent: string;
  label: string;
  status: ActivityStatus;
  startedAt?: number;
  finishedAt?: number | null;
}

export interface ActivityStep {
  id: string;
  kind: ActivityKind;
  status: ActivityStatus;
  /** the agent that performed this — undefined means the primary agent */
  agent?: string;
  title: string;
  description?: string;
  /** the tool/action label, e.g. "vault_search" */
  tool?: string;
  args?: Record<string, unknown>;
  /** full result text (the component truncates for preview) */
  result?: string;
  startedAt: number;
  finishedAt?: number | null;
  /** live sub-agents under a "delegate" step */
  branches?: ActivityBranch[];
}

export interface ActivityGroup {
  id: string;
  label: string;
  steps: ActivityStep[];
}

/** The section each activity kind belongs to, for collapsible grouping. */
const SECTION: Record<ActivityKind, string> = {
  thinking: "", // filled from context at build time
  "search-web": "Research",
  "search-vault": "Research",
  read: "Research",
  "search-data": "Data acquisition",
  plan: "Data acquisition",
  inspect: "Analysis",
  "run-code": "Analysis",
  validate: "Analysis",
  tool: "Analysis",
  delegate: "Delegation",
  output: "Synthesis",
  answer: "Synthesis",
};

/** Where a bare "Thinking" node sits when nothing precedes it. */
const DEFAULT_THINKING_SECTION = "Research";

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${++seq}`;

/** The high-level summary a Thinking node shows at a given moment. */
export type ThinkingPhase = "understanding" | "reviewing" | "synthesizing";

const THINKING_TEXT: Record<ThinkingPhase, string> = {
  understanding: "Understanding the request and planning the approach.",
  reviewing: "Reviewing what was found and planning the next step.",
  synthesizing: "Synthesizing the findings into an answer.",
};

/** Title + kind for a tool name. Unknown tools fall back to a neutral row. */
interface ToolMap {
  kind: ActivityKind;
  title: string;
}

const TOOL_MAP: Record<string, ToolMap> = {
  get_current_time: { kind: "inspect", title: "Checking the clock" },
  knowledge_search: { kind: "search-vault", title: "Searching the knowledge graph" },
  list_agents: { kind: "inspect", title: "Surveying the swarm" },
  fetch_url: { kind: "read", title: "Reading the web" },
  vault_search: { kind: "search-vault", title: "Searching the vault" },
  vault_read: { kind: "read", title: "Reading a note" },
  vault_list: { kind: "inspect", title: "Listing the vault" },
  vault_links: { kind: "inspect", title: "Walking the note graph" },
  spawn_subagent: { kind: "delegate", title: "Delegating to a sub-agent" },
  run_command: { kind: "run-code", title: "Running a command" },
};

/** A short, human description derived from a tool's arguments. */
function describeArgs(name: string, args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined;
  const str = (v: unknown) => (typeof v === "string" ? v : v == null ? undefined : JSON.stringify(v));
  switch (name) {
    case "knowledge_search":
    case "vault_search":
      return str(args.query) ?? str(args.q);
    case "fetch_url":
      return str(args.url);
    case "vault_read":
    case "vault_links":
      return str(args.path);
    case "vault_list":
      return str(args.prefix) ? `folder: ${str(args.prefix)}` : "entire vault";
    case "run_command":
      return str(args.command);
    case "spawn_subagent":
      return str(args.goal);
    default: {
      // MCP / unknown tool: show the first string argument, if any.
      for (const v of Object.values(args)) {
        const s = str(v);
        if (s) return s;
      }
      return undefined;
    }
  }
}

/** Humanize an unknown tool name into a readable title. */
function humanize(name: string): string {
  return name
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}

const TOOL_LABEL = (name: string): string => name;

/** Seed a fresh trace: the turn opens on a single Thinking node. */
export function initTrace(now: number = Date.now()): ActivityStep[] {
  return [
    {
      id: nextId("think"),
      kind: "thinking",
      status: "running",
      title: "Thinking",
      description: THINKING_TEXT.understanding,
      startedAt: now,
    },
  ];
}

/** True when the last step is a Thinking node still running. */
function openThinking(steps: ActivityStep[]): ActivityStep | undefined {
  const last = steps[steps.length - 1];
  return last && last.kind === "thinking" && last.status === "running" ? last : undefined;
}

/** Close any running Thinking node, stamping its duration. */
function closeThinking(steps: ActivityStep[], phase: ThinkingPhase, now: number): ActivityStep[] {
  const open = openThinking(steps);
  if (!open) return steps;
  return steps.map((s) =>
    s.id === open.id ? { ...s, status: "done" as const, finishedAt: now, description: THINKING_TEXT[phase] } : s,
  );
}

/** True when at least one non-Thinking step has been recorded. */
function hasWork(steps: ActivityStep[]): boolean {
  return steps.some((s) => s.kind !== "thinking");
}

/**
 * The model emitted a reasoning delta. We surface that the agent is thinking as
 * a high-level node — never the reasoning text itself, which stays in the
 * message's own collapsed Reasoning block. Recurring across the turn, this is
 * what gives the trace its "thinking between steps" rhythm, grounded in bursts
 * the model actually produced rather than fabricated.
 */
export function applyReasoning(steps: ActivityStep[], now: number = Date.now()): ActivityStep[] {
  if (openThinking(steps)) return steps;
  const phase: ThinkingPhase = hasWork(steps) ? "reviewing" : "understanding";
  return [
    ...steps,
    {
      id: nextId("think"),
      kind: "thinking",
      status: "running",
      title: "Thinking",
      description: THINKING_TEXT[phase],
      startedAt: now,
    },
  ];
}

/** A tool call beginning: close the open Thinking node and append the tool. */
export function applyToolStart(
  steps: ActivityStep[],
  e: ToolStreamEvent,
  now: number = Date.now(),
): ActivityStep[] {
  const closed = closeThinking(steps, "reviewing", now);
  const map = TOOL_MAP[e.name] ?? { kind: "tool" as const, title: humanize(e.name) };
  // A delegate step's goal lives on its branch rows, not here — echoing it as
  // the description too would print the same goal twice in one row.
  const description = map.kind === "delegate" ? undefined : describeArgs(e.name, e.args);
  return [
    ...closed,
    {
      id: nextId(e.name),
      kind: map.kind,
      status: "running",
      title: map.title,
      description,
      tool: TOOL_LABEL(e.name),
      args: e.args,
      startedAt: now,
      branches: map.kind === "delegate" ? [] : undefined,
    },
  ];
}

/** A tool finishing: settle the newest matching running step with its result. */
export function applyToolEnd(
  steps: ActivityStep[],
  e: ToolStreamEvent,
  now: number = Date.now(),
): ActivityStep[] {
  const copy = steps.slice();
  for (let i = copy.length - 1; i >= 0; i--) {
    const s = copy[i];
    if (s.status === "running" && (s.tool === e.name || s.title === humanize(e.name))) {
      copy[i] = { ...s, status: e.error ? "error" : "done", finishedAt: now, result: e.result };
      return copy;
    }
  }
  return copy;
}

/**
 * Answer text is streaming. The text itself lives in the message bubble — the
 * trace never carries the model's words, only that it is composing. So this
 * just keeps a "synthesizing" Thinking node open while the model writes,
 * except while a tool is mid-flight (that commentary belongs to the tool).
 */
export function applyText(steps: ActivityStep[], now: number = Date.now()): ActivityStep[] {
  if (openThinking(steps)) return steps;
  if (steps.some((s) => s.status === "running" && s.kind !== "thinking")) return steps;
  const closed = closeThinking(steps, "synthesizing", now);
  return [
    ...closed,
    {
      id: nextId("think"),
      kind: "thinking",
      status: "running",
      title: "Thinking",
      description: THINKING_TEXT.synthesizing,
      startedAt: now,
    },
  ];
}

/**
 * The turn settled (stream closed). Every running step becomes done; when the
 * turn did real work (at least one tool round) a final "Answer" marker closes
 * the trace, so the operator sees the run end before the conclusion beneath it.
 * A pure-text turn stays minimal — just its Thinking node.
 */
export function applyTurnEnd(steps: ActivityStep[], now: number = Date.now()): ActivityStep[] {
  const settled = steps.map((s) =>
    s.status === "running" ? { ...s, status: "done" as const, finishedAt: now } : s,
  );
  const hasTool = settled.some((s) => s.kind !== "thinking" && s.kind !== "answer");
  if (!hasTool || settled.some((s) => s.kind === "answer")) return settled;
  return [
    ...settled,
    {
      id: nextId("answer"),
      kind: "answer",
      status: "done" as const,
      title: "Answer",
      startedAt: now,
      finishedAt: now,
    },
  ];
}

/** The turn failed: mark running steps as errored. */
export function applyTurnError(steps: ActivityStep[], now: number = Date.now()): ActivityStep[] {
  return steps.map((s) => (s.status === "running" ? { ...s, status: "error" as const, finishedAt: now } : s));
}

/**
 * Fold the session's live spawn log into delegate steps. Each spawn attaches
 * to the delegate step whose role matches, or to the newest delegate step that
 * has room — so polling during a run keeps the branches current.
 */
export function syncSpawns(steps: ActivityStep[], spawns: SpawnEvent[]): ActivityStep[] {
  if (!spawns.length) return steps;
  const delegateIdx = steps.map((s, i) => (s.kind === "delegate" ? i : -1)).filter((i) => i >= 0);
  if (!delegateIdx.length) return steps;
  const copy = steps.map((s) => ({ ...s, branches: s.branches ? s.branches.slice() : s.branches }));
  for (const sp of spawns) {
    const id = sp.id ?? `${sp.role}-${sp.goal.slice(0, 12)}`;
    const status: ActivityStatus = sp.status === "running" ? "running" : sp.status === "done" ? "done" : "error";
    const branch: ActivityBranch = {
      id,
      agent: sp.role,
      label: sp.goal,
      status,
      startedAt: sp.startedAt,
      finishedAt: sp.finishedAt ?? null,
    };
    // prefer a delegate step already carrying this role as a branch
    let target = delegateIdx.find((i) => (copy[i].branches ?? []).some((b) => b.agent === sp.role));
    if (target === undefined) target = delegateIdx[delegateIdx.length - 1];
    const step = copy[target];
    const branches = step.branches ?? [];
    const existing = branches.findIndex((b) => b.id === id);
    copy[target] = {
      ...step,
      branches: existing >= 0 ? branches.map((b, j) => (j === existing ? branch : b)) : [...branches, branch],
    };
  }
  return copy;
}

/** Segment an ordered trace into contiguous, collapsible sections. */
export function buildGroups(steps: ActivityStep[]): ActivityGroup[] {
  const groups: ActivityGroup[] = [];
  let prevSection = DEFAULT_THINKING_SECTION;
  for (const s of steps) {
    const section = s.kind === "thinking" ? prevSection : SECTION[s.kind] || "Activity";
    prevSection = section;
    const last = groups[groups.length - 1];
    if (last && last.label === section) last.steps.push(s);
    else groups.push({ id: `g-${groups.length}`, label: section, steps: [s] });
  }
  return groups;
}

/** Compact duration for a settled step ("840ms" / "1.2s" / "1m 04s"). */
export function formatDuration(startedAt: number, finishedAt?: number | null): string | null {
  if (!finishedAt) return null;
  const ms = Math.max(0, finishedAt - startedAt);
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(Math.floor(s % 60)).padStart(2, "0")}s`;
}

/**
 * Rebuild a settled trace from a recorded event log — the replay path a reload
 * uses. Folds the same pure reducers the live stream drives, using each
 * envelope's own timestamp so step durations survive the round-trip.
 */
export function replayTrace(events: RunEvent[]): ActivityStep[] {
  if (!events.length) return [];
  const firstTs = events.find((e) => typeof e.t === "number")?.t ?? Date.now();
  let steps = initTrace(firstTs);
  let lastTs = firstTs;
  for (const e of events) {
    const now = typeof e.t === "number" ? e.t : lastTs;
    lastTs = now;
    if (e.type === "reasoning") steps = applyReasoning(steps, now);
    else if (e.type === "text") steps = applyText(steps, now);
    else if (e.type === "tool" && e.phase === "start") steps = applyToolStart(steps, e as ToolStreamEvent, now);
    else if (e.type === "tool" && e.phase === "end") steps = applyToolEnd(steps, e as ToolStreamEvent, now);
  }
  return applyTurnEnd(steps, lastTs);
}

/** The reasoning text a recorded log carries, for the collapsed Reasoning block. */
export function reasoningFromEvents(events: RunEvent[]): string {
  let out = "";
  for (const e of events) if (e.type === "reasoning" && typeof e.text === "string") out += e.text;
  return out;
}
