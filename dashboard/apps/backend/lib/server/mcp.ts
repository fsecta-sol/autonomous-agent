import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/**
 * Minimal MCP (Model Context Protocol) client for streamable-HTTP servers.
 *
 * This backend only uses it for the *preview* endpoint (`/api/mcp/servers/[id]/tools`),
 * which connects to a registered server and lists the tools it exports so the
 * operator can see them in the UI. The agent service connects to the same
 * servers itself at run time (via langchain-mcp-adapters) to actually call them.
 *
 * Connections are cached per server config and reused across requests; an entry
 * is dropped when its config fingerprint changes or after an idle TTL.
 */

export interface McpServerConfig {
  id: string;
  name: string;
  url: string;
  apiKey: string | null;
  enabled: boolean;
}

export interface McpToolInfo {
  name: string;
  description: string;
}

const CONNECT_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 30_000;
const IDLE_TTL_MS = 10 * 60_000;

interface CachedConn {
  client: Client;
  fingerprint: string;
  lastUsed: number;
}

const connections = new Map<string, CachedConn>();

function fingerprint(cfg: McpServerConfig): string {
  return `${cfg.url}::${cfg.apiKey ?? ""}::${cfg.enabled ? 1 : 0}`;
}

/** Open (or reuse) a connection to an MCP server. Throws on failure. */
async function connect(cfg: McpServerConfig): Promise<Client> {
  const fp = fingerprint(cfg);
  const cached = connections.get(cfg.id);
  if (cached && cached.fingerprint === fp) {
    cached.lastUsed = Date.now();
    return cached.client;
  }
  if (cached) {
    void cached.client.close().catch(() => {});
    connections.delete(cfg.id);
  }

  const client = new Client({ name: "dashboard-backend", version: "1.0.0" });
  const headers: Record<string, string> = {};
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  const transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
    requestInit: { headers },
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CONNECT_TIMEOUT_MS);
  try {
    await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
  connections.set(cfg.id, { client, fingerprint: fp, lastUsed: Date.now() });
  return client;
}

/** Proactively drop connections idle beyond the TTL (called opportunistically). */
function sweep(): void {
  const now = Date.now();
  for (const [id, conn] of connections) {
    if (now - conn.lastUsed > IDLE_TTL_MS) {
      void conn.client.close().catch(() => {});
      connections.delete(id);
    }
  }
}

export async function closeAllMcpConnections(): Promise<void> {
  for (const [id, conn] of connections) {
    void conn.client.close().catch(() => {});
    connections.delete(id);
  }
}

/** List the tool names an MCP server exports (for the UI preview). */
export async function listMcpTools(cfg: McpServerConfig, signal?: AbortSignal): Promise<McpToolInfo[]> {
  sweep();
  const client = await connect(cfg);
  const res = await client.listTools({}, { timeout: CALL_TIMEOUT_MS, signal });
  return (res.tools ?? []).map((t) => ({ name: t.name, description: t.description || t.name }));
}
