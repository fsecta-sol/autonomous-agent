export type OrchCol = "queued" | "planning" | "running" | "review" | "done";

export interface OrchTask {
  id: string;
  run: string;
  col: OrchCol;
  title: string;
  agent: string;
  tags: string[];
  eta: string;
  deps: number;
  blocked?: boolean;
}

export const ORCH_RUNS: Record<string, string> = {
  digest: "Research digest",
  refund: "Refund sweep",
  docs: "Docs refresh",
};

export const ORCH_COLS: [OrchCol, string][] = [
  ["queued", "Queued"],
  ["planning", "Planning"],
  ["running", "Running"],
  ["review", "Review"],
  ["done", "Done"],
];

export const ORCH_TASKS: OrchTask[] = [
  { id: "g1", run: "digest", col: "done", title: "Pull 40 competitor changelogs", agent: "Scout", tags: ["scrape"], eta: "4m", deps: 0 },
  { id: "g2", run: "digest", col: "done", title: "Dedupe + cluster entries by theme", agent: "Scout", tags: ["nlp"], eta: "2m", deps: 1 },
  { id: "g3", run: "digest", col: "running", title: "Draft digest sections from clusters", agent: "Quill", tags: ["write"], eta: "~6m", deps: 1 },
  { id: "g4", run: "digest", col: "planning", title: "Fact-check the pricing claims", agent: "Ledger", tags: ["verify"], eta: "queued", deps: 1 },
  { id: "g5", run: "digest", col: "queued", title: "Editorial pass + tighten to 600 words", agent: "Ink", tags: ["edit"], eta: "—", deps: 2 },
  { id: "g6", run: "digest", col: "queued", title: "Publish to /digest, notify #growth", agent: "Atlas", tags: ["ship"], eta: "—", deps: 1 },
  { id: "r1", run: "refund", col: "done", title: "Export disputed charges for March", agent: "Tally", tags: ["export"], eta: "3m", deps: 0 },
  { id: "r2", run: "refund", col: "running", title: "Match charges to order + shipping records", agent: "Tally", tags: ["match"], eta: "~9m", deps: 1 },
  { id: "r3", run: "refund", col: "planning", title: "Flag partial-refund candidates by rule", agent: "Ledger", tags: ["rules"], eta: "queued", deps: 1 },
  { id: "r4", run: "refund", col: "review", title: "Human review of 12 edge cases", agent: "Echo", tags: ["review"], eta: "hold", deps: 1 },
  { id: "r5", run: "refund", col: "queued", title: "Issue approved refunds via Stripe", agent: "Tally", tags: ["ship"], eta: "—", deps: 2, blocked: true },
  { id: "d1", run: "docs", col: "done", title: "Diff merged PRs since v3.3", agent: "Forge", tags: ["scan"], eta: "1m", deps: 0 },
  { id: "d2", run: "docs", col: "done", title: "Group changes by surface area", agent: "Ink", tags: ["nlp"], eta: "2m", deps: 1 },
  { id: "d3", run: "docs", col: "running", title: "Write the v3.4 release notes", agent: "Ink", tags: ["write"], eta: "~5m", deps: 1 },
  { id: "d4", run: "docs", col: "planning", title: "Screenshot the 3 new screens", agent: "Atlas", tags: ["media"], eta: "queued", deps: 0 },
  { id: "d5", run: "docs", col: "queued", title: "Review + merge the docs PR", agent: "Quill", tags: ["review"], eta: "—", deps: 2 },
];

export interface OrchLane {
  ln: string;
  blocks: { l: number; w: number; k: "done" | "run" }[];
}

export const ORCH_LANES: OrchLane[] = [
  { ln: "Scout", blocks: [{ l: 4, w: 20, k: "done" }, { l: 28, w: 40, k: "done" }, { l: 72, w: 26, k: "run" }] },
  { ln: "Quill", blocks: [{ l: 10, w: 16, k: "done" }, { l: 60, w: 38, k: "run" }] },
  { ln: "Ink", blocks: [{ l: 2, w: 12, k: "done" }, { l: 16, w: 14, k: "done" }, { l: 55, w: 43, k: "run" }] },
  { ln: "Tally", blocks: [{ l: 0, w: 34, k: "done" }, { l: 40, w: 30, k: "done" }, { l: 74, w: 24, k: "run" }] },
  { ln: "Echo", blocks: [{ l: 20, w: 50, k: "run" }, { l: 72, w: 26, k: "run" }] },
];
