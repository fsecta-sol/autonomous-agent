/**
 * The builtin tool catalog. The implementations live in the agent service
 * (Python); this is the backend's single source of truth for tool *names*
 * — used to render the tool picker and to resolve which tools an agent has.
 *
 * Every name here must have a matching implementation in `apps/agent`
 * (`agent/tools/*` or the remote callbacks in `agent/tools/remote.py`).
 * `list_agents` and `knowledge_search` are implemented in this backend and
 * called back over HTTP; the rest run inside the agent process.
 */
export interface ToolInfo {
  name: string;
  description: string;
  /** exposed to the model when the agent does not name a set explicitly */
  enabledByDefault: boolean;
  /** hidden from the generic tool picker (configured elsewhere, e.g. terminal) */
  hidden?: boolean;
}

export const TOOL_CATALOG: ToolInfo[] = [
  {
    name: "get_current_time",
    description: "Return the current date and time in ISO 8601 (UTC).",
    enabledByDefault: true,
  },
  {
    name: "knowledge_search",
    description:
      "Search the workspace knowledge graph for concepts whose title matches a query. " +
      "Returns matching concepts with their layer, type and degree. Use this before " +
      "answering questions about concepts the workspace tracks.",
    enabledByDefault: true,
  },
  {
    name: "list_agents",
    description: "List the research swarm's agents, their roles, and what each is currently working on.",
    enabledByDefault: true,
  },
  {
    name: "fetch_url",
    description:
      "Fetch a public web page and return its text content as clean Markdown (HTML stripped, " +
      "truncated; PDFs are text-extracted). Handles Cloudflare-protected pages automatically by " +
      "escalating from a fast HTTP fetch to a headless browser that can solve the challenge. Use " +
      "to read documentation or articles the user references by URL.",
    enabledByDefault: true,
  },
  {
    name: "vault_search",
    description:
      "Search the operator's notes vault. Returns the best-matching notes ranked by relevance, " +
      "each with its path, title, frontmatter (concept/layer/type/status) and a text snippet. " +
      'Quote a phrase ("exact words") to require it verbatim. Use this before answering questions ' +
      "about concepts, projects, or research the vault tracks.",
    enabledByDefault: true,
  },
  {
    name: "vault_read",
    description:
      "Read one note from the operator's vault by its vault-relative path (as returned by " +
      "vault_search or vault_list). Returns the note's full text.",
    enabledByDefault: true,
  },
  {
    name: "vault_list",
    description:
      "List notes in the operator's vault, optionally restricted to a folder prefix. " +
      "Returns vault-relative paths and sizes. Use it to survey what a folder contains.",
    enabledByDefault: true,
  },
  {
    name: "vault_links",
    description:
      "Given a note's vault-relative path, return the notes it links to (outgoing [[wikilinks]]) " +
      "and the notes that link back to it (incoming). Use it to walk the knowledge graph from a note.",
    enabledByDefault: true,
  },
  {
    name: "spawn_subagent",
    description:
      "Delegate a focused piece of work to a sub-agent and get its result back. Use it to " +
      "decompose or parallelize a task (e.g. one sub-agent gathers sources, another checks a " +
      "specific relationship). Off by default; enable it on the agent you want to act as an " +
      "orchestrator.",
    enabledByDefault: false,
  },
  {
    name: "batch_research",
    description:
      "Run the same task over many items in parallel, one sub-agent per item (e.g. check " +
      "liquidity for each of these 30 tokens at once). Use it instead of many spawn_subagent " +
      "calls when the work is the same shape repeated across a list. Off by default; enable it " +
      "on the agent you want to act as an orchestrator.",
    enabledByDefault: false,
  },
  {
    name: "memory_save",
    description:
      "Save a durable fact to long-term memory, remembered across future chats (a conclusion, " +
      "a decision the operator made, a reliable source). Off by default; enable it on agents " +
      "that should build up knowledge over time.",
    enabledByDefault: false,
  },
  {
    name: "memory_search",
    description:
      "Search long-term memory for facts saved in this or earlier chats. Use it before starting " +
      "research on a subject to recall what was already established. Off by default.",
    enabledByDefault: false,
  },
  {
    name: "memory_forget",
    description:
      "Delete one long-term memory by its key, as returned by memory_save or memory_search. " +
      "Off by default.",
    enabledByDefault: false,
  },
  {
    name: "knowledge_get",
    description:
      "Read one node from the knowledge graph by its ID/slug (e.g. \"mev\"). Returns its " +
      "metadata and relationships; pass with_body to include the full note text. The graph is " +
      "the Markdown vault; this is the lifecycle-aware read of it.",
    enabledByDefault: true,
  },
  {
    name: "knowledge_relevant",
    description:
      "Retrieve the knowledge-graph nodes relevant to a task, with source, confidence, " +
      "verification status, relationships and last-updated time. Use it before researching a " +
      "topic so you reuse what the graph already knows instead of rediscovering it.",
    enabledByDefault: true,
  },
  {
    name: "knowledge_health",
    description:
      "Report the knowledge graph's health: node/relationship counts, verified vs unverified " +
      "notes, conflicts, open unknowns, broken links and orphans.",
    enabledByDefault: true,
  },
  {
    name: "knowledge_upsert",
    description:
      "Integrate a durable fact into the knowledge graph — dedup, conflict detection, then " +
      "create or enrich the right Markdown note (never blindly appends). Off by default; enable " +
      "it on agents that should accumulate knowledge. Writes to the operator's vault.",
    enabledByDefault: false,
  },
  {
    name: "knowledge_relate",
    description:
      "Add a typed relationship between two knowledge nodes and its reciprocal (builds-on, " +
      "enables, related, depends_on, part_of, caused_by, implements, supports, contradicts, " +
      "supersedes, derived_from). Off by default; writes to the operator's vault.",
    enabledByDefault: false,
  },
  {
    name: "knowledge_record",
    description:
      "Record a knowledge lifecycle event on a node: attach evidence, verify, log a conflict, " +
      "open an unknown, or resolve one (select via `kind`). Off by default; writes to the " +
      "operator's vault.",
    enabledByDefault: false,
  },
  {
    name: "knowledge_supersede",
    description:
      "Mark a knowledge node superseded by a newer one, preserving the old note for history. " +
      "Off by default; writes to the operator's vault.",
    enabledByDefault: false,
  },
  {
    name: "run_command",
    description:
      "Run a shell command and return its output. Whether this executes sandboxed or with full access is fixed by the operator's configuration for this agent.",
    enabledByDefault: false,
    hidden: true, // configured via the agent's Terminal setting, not the tool picker
  },
];

const BY_NAME = new Map(TOOL_CATALOG.map((t) => [t.name, t]));

export function isKnownTool(name: string): boolean {
  return BY_NAME.has(name);
}

/**
 * Resolve the builtin tool names exposed for a request. `undefined` (client
 * omitted the field) means the default-enabled set; an explicit array —
 * including an empty one — is honored as-is (unknown names are dropped).
 */
export function selectToolNames(names: string[] | undefined): string[] {
  if (names === undefined) {
    return TOOL_CATALOG.filter((t) => t.enabledByDefault).map((t) => t.name);
  }
  return names.filter(isKnownTool);
}

/** Names available to the client for the generic tool picker (hidden ones excluded). */
export function toolCatalog(): Array<{ name: string; description: string; enabledByDefault: boolean }> {
  return TOOL_CATALOG.filter((t) => !t.hidden).map((t) => ({
    name: t.name,
    description: t.description,
    enabledByDefault: t.enabledByDefault,
  }));
}
