import type { ActivityDay, ActivityEvent, PipelineRun, KnowledgeSource } from "@dashboard/shared";

export const CRON: PipelineRun[] = [
  { id: "process-inbox-knowledge", name: "process-inbox-knowledge", cadence: "every 30 min", last: "13:30", state: "idle", agent: "Kai" },
  { id: "process-inbox-projects", name: "process-inbox-projects", cadence: "every 30 min", last: "13:30", state: "idle", agent: "Vale" },
  { id: "graph-walker", name: "graph-walker", cadence: "every 6h", last: "12:00", state: "reviewed, no changes", agent: "Tally" },
  { id: "scan-curated-sources", name: "scan-curated-sources", cadence: "daily 06:00", last: "06:00", state: "1 update", agent: "Moss" },
];

const ev = (
  id: string,
  time: string,
  job: string,
  agent: string,
  category: ActivityEvent["category"],
  idle: boolean,
  text: string,
  provenance: string,
  flag?: string,
): ActivityEvent => ({ id, time, job, agent, category, idle, text, provenance, flag });

export const ACTIVITY_DAYS: ActivityDay[] = [
  {
    key: "today",
    label: "Today",
    log: [
      ev("t1", "13:30", "process-inbox-knowledge", "Kai", "pipelines", true, "idle — wake-gate found no new input", "inbox / knowledge"),
      ev("t2", "13:30", "process-inbox-projects", "Vale", "pipelines", true, "idle — wake-gate found no new input", "inbox / projects"),
      ev("t3", "12:00", "graph-walker", "Tally", "reviews", true, "reviewed 18 notes, 0 relink suggestions", "graph audit"),
      ev("t4", "11:00", "process-inbox-knowledge", "Kai", "knowledge", false, "enriched [[MEV]] with execution context", "inbox / mev-brief.md"),
      ev("t5", "09:00", "process-inbox-projects", "Vale", "knowledge", false, "created [[Memecoin]] in market layer", "project intake"),
      ev("t6", "06:30", "process-inbox-knowledge", "Kai", "knowledge", false, "created [[Bonding Curve]] in applications layer", "curated source"),
      ev("t7", "06:00", "scan-curated-sources", "Moss", "reviews", false, "flagged [[Copy Trading]] for classification", "source scan", "NEEDS-CLASSIFICATION"),
    ],
  },
  {
    key: "d05",
    label: "05 Sep",
    log: [
      ev("d5-1", "13:30", "graph-walker", "Tally", "reviews", false, "reviewed 18 notes; accepted 2 relink proposals", "graph audit"),
      ev("d5-2", "12:00", "process-inbox-knowledge", "Kai", "pipelines", true, "idle — wake-gate found no new input", "inbox / knowledge"),
      ev("d5-3", "11:00", "graph-walker", "Tally", "relationships", false, "connected 2 orphans: [[Light Client]], [[Automated Market Maker]]", "graph audit"),
      ev("d5-4", "09:00", "process-inbox-projects", "Vale", "knowledge", false, "created [[Memecoin]] in market layer", "project intake"),
      ev("d5-5", "06:30", "process-inbox-knowledge", "Kai", "knowledge", false, "created [[Bonding Curve]] in applications layer", "curated source"),
      ev("d5-6", "06:00", "scan-curated-sources", "Moss", "reviews", false, "flagged [[Copy Trading]] for source review", "source scan", "NEEDS-SOURCE"),
    ],
  },
  {
    key: "d04",
    label: "04 Sep",
    log: [
      ev("d4-1", "22:10", "scan-curated-sources", "Moss", "knowledge", false, "logged correlation study: mempool to applications (+0.78)", "curated source"),
      ev("d4-2", "13:30", "process-inbox-knowledge", "Kai", "pipelines", true, "idle — wake-gate found no new input", "inbox / knowledge"),
      ev("d4-3", "12:00", "graph-walker", "Tally", "reviews", true, "reviewed 16 notes, 0 relink suggestions", "graph audit"),
      ev("d4-4", "07:30", "process-inbox-projects", "Vale", "pipelines", true, "idle — wake-gate found no new input", "inbox / projects"),
      ev("d4-5", "06:00", "scan-curated-sources", "Moss", "pipelines", true, "idle — curated sources unchanged", "source scan"),
    ],
  },
];

export const INBOX_PENDING = [
  "2026-09-05-nightly-auto-digest.md",
  "2026-09-04-nightly-auto-digest.md",
  "2026-09-03-nightly-auto-digest.md",
  "2026-09-02-websocket-live-market-data-research.md",
  "2026-09-02-nightly-auto-digest.md",
  "2026-09-01-b1-c2-results.md",
  "2026-09-01-exit-tuning-verdict.md",
  "2026-09-01-gate-hit-reconcile.md",
  "2026-09-01-nightly-auto-digest.md",
  "2026-08-31-follow-the-money.md",
  "2026-08-31-root-trace.md",
  "2026-08-31-whale-decode-v2.md",
  "2026-08-31-wash-trader-tag-audit.md",
  "2026-08-30-shallow-dip-verdict.md",
  "2026-08-30-volume-lowbuy-verdict.md",
];

const padTopics = ["nightly-auto-digest", "wallet-pipeline-log", "signal-drift-check", "liquidity-map-refresh", "edge-latency-probe"];
["2026-08-29", "2026-08-29", "2026-08-28", "2026-08-27", "2026-08-26", "2026-08-25", "2026-08-24", "2026-08-23", "2026-08-22", "2026-08-21", "2026-08-20"].forEach(
  (d, k) => {
    INBOX_PENDING.push(`${d}-${padTopics[k % padTopics.length]}.md`);
  },
);

export const PROCESSED = [
  { date: "2026-08-18", n: 3 },
  { date: "2026-08-17", n: 4 },
  { date: "2026-08-16", n: 2 },
  { date: "2026-08-15", n: 5 },
  { date: "2026-08-14", n: 3 },
  { date: "2026-08-13", n: 2 },
  { date: "2026-08-12", n: 6 },
  { date: "2026-08-11", n: 3 },
  { date: "2026-08-10", n: 4 },
  { date: "2026-08-09", n: 2 },
  { date: "2026-08-08", n: 3 },
  { date: "2026-08-07", n: 4 },
];
export const PROCESSED_TOTAL = 45;
export const TODAY_ISO = "2026-09-06";

export function daysBetween(iso: string): number {
  return Math.round((new Date(TODAY_ISO + "T00:00:00").getTime() - new Date(iso + "T00:00:00").getTime()) / 86400000);
}

export const SOURCES: KnowledgeSource[] = [
  { id: "s1", label: "mev-brief.md", kind: "inbox", addedAt: "05 Sep 2026" },
  { id: "s2", label: "nightly-auto-digest.md", kind: "inbox", addedAt: "05 Sep 2026" },
  { id: "s3", label: "curated research feed", kind: "curated", addedAt: "04 Sep 2026" },
  { id: "s4", label: "protocol documentation set", kind: "curated", addedAt: "04 Sep 2026" },
  { id: "s5", label: "project intake queue", kind: "project", addedAt: "03 Sep 2026" },
  { id: "s6", label: "topology audit reports", kind: "analysis", addedAt: "03 Sep 2026" },
];

export const REVIEW_TITLES = ["Copy Trading", "Block Production", "Verifiable Agent Computation"];

export const DANGLING = {
  missing: [{ ref: "lapis", count: 2 }],
  routed: [
    "aptos", "sui", "monad", "near-protocol", "jito", "arbitrum", "bnb-chain", "optimism", "zora", "polygon-zkevm", "concept",
  ],
};

export const GROWTH_SERIES = {
  nodes: { values: [131, 187, 246], count: 246, unit: "knowledge nodes", delta: "+5 this week" },
  relationships: { values: [318, 527, 746], count: 746, unit: "relationships", delta: "+64 this week" },
  sources: { values: [82, 119, 156], count: 156, unit: "sources", delta: "+11 this week" },
} as const;
