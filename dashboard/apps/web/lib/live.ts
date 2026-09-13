import type { SwarmActivityItem } from "@dashboard/shared";

/**
 * Live event source for swarm activity.
 *
 * Today items are synthesized locally on an interval so the interface behaves
 * like the real thing. The transport is deliberately isolated behind
 * `subscribeSwarmActivity`: swap the body for an EventSource / WebSocket
 * reader emitting the same shape and every consumer keeps working.
 */

const SEED_ITEMS: Omit<SwarmActivityItem, "id">[] = [
  { agent: "kai", text: "discovered **Anthropic MCP Architecture** and drafted a new source note", node: "MEV", time: "12 sec ago" },
  { agent: "vale", text: "extracted 8 entities from **Research Paper.pdf**", node: "Sandwich Attack", time: "24 sec ago" },
  { agent: "tally", text: "validated relationship: **MEV** → **Sandwich Attack**", node: "MEV", time: "41 sec ago" },
  { agent: "moss", text: "created 4 new topic clusters under **Liquidity**", node: "Bonding Curve", time: "1 min ago" },
  { agent: "wick", text: "queued 2 outbound research tasks for the swarm", node: "Copy Trading", time: "2 min ago" },
  { agent: "echo", text: "indexed 6 sources from the morning inbox run", node: "Memecoin", time: "3 min ago" },
];

const POOL_ITEMS: Omit<SwarmActivityItem, "id" | "time">[] = [
  { agent: "kai", text: "connected **MEV** to 3 new source documents", node: "MEV" },
  { agent: "vale", text: "extracted 6 entities from **Sandwich Attack**", node: "Sandwich Attack" },
  { agent: "tally", text: "approved 5 relationships submitted by Vale", node: "MEV" },
  { agent: "moss", text: "re-clustered **Bonding Curve** into 2 topic groups", node: "Bonding Curve" },
  { agent: "wick", text: "dispatched a research task to the swarm", node: "Copy Trading" },
  { agent: "echo", text: "flagged **Memecoin** for a missing source", node: "Memecoin" },
];

let seq = 0;

function makeItem(item: Omit<SwarmActivityItem, "id" | "time">, time: string): SwarmActivityItem {
  seq += 1;
  return { ...item, id: `live-${seq}`, time };
}

export interface SwarmActivitySubscription {
  /** immediately receives the seed backlog, then push items while live */
  unsubscribe: () => void;
}

/**
 * Subscribe to the swarm activity stream. `onItem` receives the seed backlog
 * synchronously, then new items while `live` is true. Pausing is a UI concern:
 * the subscription keeps running so the historical stream stays complete.
 */
export function subscribeSwarmActivity(onItem: (item: SwarmActivityItem) => void, intervalMs = 9000): SwarmActivitySubscription {
  let pi = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  SEED_ITEMS.forEach((s) => onItem(makeItem(s, s.time)));

  timer = setInterval(() => {
    const it = POOL_ITEMS[pi % POOL_ITEMS.length];
    pi += 1;
    onItem(makeItem(it, "just now"));
  }, intervalMs);

  return {
    unsubscribe: () => {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
