# autonomous-agent dashboard

A monorepo of three services plus a shared package. The dashboard is the
control-and-observability surface for a personal Hermes-based autonomous agent
system (see `PRODUCT.md`).

```
dashboard/
├── apps/
│   ├── web/       Next.js — frontend UI only
│   ├── backend/   Next.js — API only (auth, agents, chats, skills, mcp, …)
│   └── agent/     Python — FastAPI + LangGraph (the model↔tool runtime)
└── packages/
    └── shared/    TS — graph-data, concept-pools, types (used by web + backend)
```

## How the pieces fit

- The browser only talks to **web**. `web/next.config.ts` rewrites `/api/*` to
  **backend**, so session cookies stay same-origin — no CORS.
- **backend** owns the SQLite database and resolves everything a run needs
  (agent persona, skills, tool set, MCP servers, upstream credentials), then
  POSTs that to **agent** `/run` and streams the agent's SSE back to the browser.
- **agent** is stateless: it runs a LangGraph ReAct agent with the tools the
  backend handed it, connects to MCP servers itself, and calls back to the
  backend's `/internal/tools/*` for data it doesn't own (the swarm roster and
  the knowledge graph). It never touches the database.
- The SSE envelope protocol (`text` / `reasoning` / `tool` / `warning` /
  `error` / `done`) is unchanged from the original single-service app, so
  `apps/web/lib/llm-stream.ts` and every component work as-is.

## Running (dev)

```bash
npm install                      # root workspace install
npm run dev:backend              # http://localhost:3011
npm run dev:web                  # http://localhost:3010
cd apps/agent && uv run uvicorn agent.main:app --port 8012
```

Copy each app's `env.example` to `.env.local` (backend/web) or `.env` (agent)
first. `INTERNAL_TOOL_TOKEN` must be identical in the backend and agent envs.

## Running (prod)

`npm run build` builds backend then web; `apps/agent` needs no build step.
Three systemd user units live in `deploy/systemd/` (`hermes-swarm-agent`,
`-backend`, `-web`); copy them to `~/.config/systemd/user/` and
`systemctl --user enable --now hermes-swarm-{agent,backend,web}`.

## Ports

| service | default port | env |
|---------|--------------|-----|
| web     | 3010         | `WEB_PORT` |
| backend | 3011         | `BACKEND_PORT` |
| agent   | 8012         | `AGENT_PORT` |
