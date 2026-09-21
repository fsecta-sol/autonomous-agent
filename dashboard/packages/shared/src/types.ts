export type Layer =
  | "cryptography"
  | "foundations"
  | "platforms"
  | "applications"
  | "market"
  | "cross-cutting";

export type NodeType =
  | "system"
  | "fundamental"
  | "economy"
  | "programming"
  | "concept"
  | "cross-cutting"
  | "trading"
  | "blockchain";

export type NodeTier = "pillar" | "primary" | "secondary" | "peripheral";

export type NodeStatus = "active" | "needs-link";

export type ReviewMarker = "NEEDS-SOURCE" | "NEEDS-WHY" | "NEEDS-EXAMPLES" | "NEEDS-CLASSIFICATION";

export interface KnowledgeNode {
  id: string;
  label: string;
  type: NodeType;
  layer: Layer;
  /** graph degree — drives tier + radius */
  degree: number;
  tier: NodeTier;
  importance: number;
  status: NodeStatus;
  markers: ReviewMarker[];
  created: string;
  updated: string;
  recent: boolean;
  sources: number;
  createdAt: string;
  linksOut: number;
  linksIn: number;
}

export type RelationshipType = "builds-on" | "enables" | "related";

export interface KnowledgeRelationship {
  id: string;
  source: number;
  target: number;
  type: RelationshipType;
  strength: number;
  /** "" | "is-strong" | "is-very-strong" — render tier */
  tier: "" | "is-strong" | "is-very-strong";
}

export type AgentStatus =
  | "working"
  | "analysing"
  | "idle"
  | "pending";

/**
 * The execution policy for protected tool actions (tools that would otherwise
 * stop for operator approval, e.g. `run_command`).
 *   ask    — the run pauses; the operator approves or rejects each action.
 *   bypass — the action runs without an interactive gate. This is NOT "approved":
 *            no approval was requested, let alone granted. The only boundary it
 *            removes is the interactive one; every other safety check stands.
 */
export type PermissionMode = "ask" | "bypass";

/**
 * The outcome of a protected tool's permission check. `bypassed` is its own
 * state, never folded into `approved`: under bypass no decision was requested or
 * granted — the gate was skipped. Keeping them distinct is what lets the UI say
 * "permission bypassed" instead of falsely implying operator consent.
 */
export type PermissionDecision = "pending" | "approved" | "rejected" | "bypassed" | "denied";

export interface AgentHealthMeter {
  k: string;
  v: string;
  pct: number;
}

export interface AgentHeartbeat {
  cls: "" | "warn" | "err";
  time: string;
  text: string;
}

export interface AgentIncident {
  when: string;
  text: string;
}

export interface AgentHealth {
  heartbeat: string;
  beatOk: boolean;
  uptime: string;
  queue: string;
  errRate: string;
  errWarn: boolean;
  throughput: string;
  meters: AgentHealthMeter[];
  beats: AgentHeartbeat[];
  incidents: AgentIncident[];
}

/** The live runtime state of an agent, derived from real activity — never hardcoded.
 *  `working` = a run is in flight; `live` = recent activity; `stale` = a run has
 *  gone quiet mid-flight; `idle` = resting (no recent activity); `offline` = the
 *  telemetry feed itself is unreachable (set client-side when polling fails). */
export type TelemetryState = "working" | "live" | "idle" | "stale" | "offline";

/** Latency measured from real turns (ms). `null` means "not enough history". */
export interface LatencyStats {
  /** most recent time-to-first-token (live, or measured from a log's lead-in) */
  ttft: number | null;
  /** most recent full-turn duration */
  total: number | null;
  /** p95 of full-turn durations over the window */
  p95: number | null;
  /** number of turns the stats are built from */
  samples: number;
}

/** One agent's runtime telemetry, all derived from real backend state. */
export interface AgentTelemetry {
  agentId: string;
  state: TelemetryState;
  /** ms since this agent was last active (any turn/tool/event); null = never */
  heartbeatAgeMs: number | null;
  /** epoch ms of that last activity, null = never */
  heartbeatAt: number | null;
  queue: {
    /** runs currently in flight */
    running: number;
    /** runs paused awaiting tool approval */
    paused: number;
  };
  /** completed turns within the window */
  completed: number;
  /** completed turns per hour over the window */
  throughputPerHour: number;
  /** failed turns / total turns over the window; null when there is no history */
  errorRate: number | null;
  latency: LatencyStats;
  /** the aggregation window these figures cover (ms) */
  windowMs: number;
  /** true once there is at least one completed turn to measure */
  hasHistory: boolean;
}

/** The whole-swarm telemetry snapshot, polled by the UI. */
export interface SwarmTelemetry {
  /** epoch ms the snapshot was taken */
  at: number;
  /** ms the backend process has been up */
  uptimeMs: number;
  /** the backend's own most recent activity (epoch ms) */
  heartbeatAt: number;
  agents: Record<string, AgentTelemetry>;
  totals: {
    running: number;
    paused: number;
    completed: number;
    errorRate: number | null;
  };
}

export interface ChatMessage {
  role: "you" | "agent" | "system";
  body: string;
  /** the model's streamed reasoning for this turn, if it emitted any */
  reasoning?: string;
  links?: string[];
  /** the persisted turn's seq within its session — the anchor regenerate /
   *  edit-and-resend rewind to. Absent on a turn that is not yet saved. */
  seq?: number;
  /** filenames attached to this turn (content is folded into body when sent) */
  files?: string[];
  /** the settled execution trace, rebuilt from a persisted event log */
  trace?: import("./execution").ActivityStep[];
  openIdx?: number;
  stamp?: string;
}

export interface HistoryThread {
  title: string;
  thread: ChatMessage[];
}

export interface AgentHistoryGroup {
  when: string;
  items: HistoryThread[];
}

export interface Agent {
  id: string;
  name: string;
  role: string;
  status: AgentStatus;
  /** title of the graph node this agent is currently working on, if any */
  currentNode: string | null;
  task: string;
  progress: number;
  count: string;
  focus: string;
  seed: ChatMessage[];
  history: AgentHistoryGroup[];
  health: AgentHealth;
}

export interface AgentTask {
  id: string;
  run: string;
  col: "queued" | "planning" | "running" | "review" | "done";
  title: string;
  agent: string;
  tags: string[];
  eta: string;
  deps: number;
  blocked?: boolean;
}

export interface PipelineRun {
  id: string;
  name: string;
  cadence: string;
  last: string;
  state: string;
  agent: string;
}

export type ActivityCategory =
  | "knowledge"
  | "relationships"
  | "agents"
  | "pipelines"
  | "reviews";

export interface ActivityEvent {
  id: string;
  time: string;
  job: string;
  agent: string;
  category: ActivityCategory;
  idle: boolean;
  text: string;
  provenance: string;
  flag?: string;
}

export interface ActivityDay {
  key: string;
  label: string;
  log: ActivityEvent[];
}

export interface KnowledgeSource {
  id: string;
  label: string;
  kind: "curated" | "inbox" | "project" | "analysis";
  addedAt: string;
}

export interface SwarmActivityItem {
  id: string;
  agent: string;
  text: string;
  node: string | null;
  time: string;
}

export type GraphMode = "field" | "structured";

export interface Thought {
  id: number;
  text: string;
  depth: "quick" | "standard" | "deep";
  status: "researching" | "linked" | "standalone";
  /** node indices this thought is linked to in the graph */
  conn: number[];
  nodeIdx: number | null;
  stamp: string;
  ts: number;
  messages: ChatMessage[];
}
