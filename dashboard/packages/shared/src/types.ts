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

export interface ChatMessage {
  role: "you" | "agent" | "system";
  body: string;
  /** the model's streamed reasoning for this turn, if it emitted any */
  reasoning?: string;
  links?: string[];
  /** filenames attached to this turn (content is folded into body when sent) */
  files?: string[];
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
