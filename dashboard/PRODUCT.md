# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

A single operator — the owner of a personal autonomous crypto-research agent —
working alone, self-hosted, from a laptop while the agent runs on a headless
Ubuntu server. Their job on this surface: see what the autonomous agent has
produced (the knowledge graph it grows, the agents that run, the research they
emit) and steer it, without dropping to SSH, cron logs, or the raw vault.

## Product Purpose

A personal control-and-observability surface for one autonomous agent system.
It renders the personal knowledge graph as the centerpiece, shows the swarm of
research agents and what each is doing, and hosts the native chat that drives
them. Success means the operator can grasp the state of the knowledge graph and
direct the agents from one screen — turning "compound understanding" into
something inspectable and steerable rather than a black box running on a cron.

## Positioning

A control plane purpose-built for **one specific** Hermes-based curation
pipeline and its personal Obsidian vault — not a generic chatbot UI and not a
generic dashboard. Open WebUI was explicitly rejected in favor of a native chat
that proxies any OpenAI-compatible endpoint. The knowledge graph — precomputed
at build time, one operator's own concepts — is the thing no neighboring product
can copy; everything else frames it.

## Operating Context

- Runs on the same Ubuntu server as the Hermes Agent cron runtime. The surface
  is split into three services — `web` (UI, :3010), `backend` (API, :3011), and
  `agent` (LangGraph runtime, :8012) — each an independent process, with the
  browser reaching the backend via a same-origin `/api/*` rewrite.
- Four live cron jobs feed it: `process-inbox-knowledge` (30 min),
  `process-inbox-projects` (30 min), `graph-walker` (6h), `scan-curated-sources`
  (daily 06:00); results are delivered to Telegram.
- The real vault (`~/vault/`): 246 concept notes in `03-Areas/concepts/`, 16
  project notes in `02-Projects/` (different frontmatter schema), daily logs as
  `.txt` in `01-Daily/`.
- Product docs (README/MISSION/STATUS/ARCH/TLDR) are Indonesian; vault notes are
  English. Both are deliberate.
- North star for the wider system: "create my own edge in crypto through
  compound understanding." Non-goals: not a trading bot, not a signal service,
  not a news aggregator.

## Capabilities and Constraints

- Stack: Next.js 16 App Router + Turbopack, React 19, Tailwind v4, d3-force with
  a hand-written Canvas 2D graph renderer, better-sqlite3 + Drizzle (backend),
  and FastAPI + LangGraph (agent, Python).
- **Monochrome only** — the visual identity is deliberately single-hue.
- The knowledge graph is generated in-process from `packages/shared`
  (`graph-data.ts` + `concept-pools.ts`); the client does zero layout.
- Chat is native, proxying any OpenAI-compatible endpoint. The backend resolves
  the endpoint + key and hands them to the stateless agent per run; the key never
  reaches the browser. Sessions, messages, agents, agent configs, MCP servers,
  and skills persist in SQLite (owned solely by the backend).
- Agents are first-class data (create/edit/delete in the UI), each with its own
  optional endpoint + key + model, plus tools, skills, MCP servers (streamable
  HTTP), and a terminal mode (`off` / `sandbox` / `unsandboxed`).
- Terminology in use: agent, session, message, skill, MCP server, terminal mode,
  tool, node, edge/relationship, layer, concept, project.
- Undecided / not yet built (do not treat as settled): real backend auth (only a
  local client gate today); per-agent API keys are stored plaintext in SQLite;
  agent health/telemetry is neutral (no runtime feed); cron scheduling shown in
  the UI is display-only; the graph renders the committed sample vault until a
  build against the real vault is run.

## Brand Commitments

- Name: **autonomous-agent** (the dashboard is its control surface).
- Near-monochrome: a neutral ink / bg / surface / hairline base carrying a single
  blue accent reserved for interaction and state, plus six layer hues scoped to
  the knowledge graph only. Sharp corners everywhere (radius 0, enforced globally).
- Indonesian for product documentation, English for vault notes — both
  intentional and to be preserved.

## Evidence on Hand

- Real vault at `~/vault/` — 246 concept notes, 16 project notes (paths above).
- The dashboard renders a committed ~50-note sample vault, not the real one, as
  of the last recorded build.
- Live Hermes cron jobs and Telegram delivery (verified via `hermes cron list`).
- Design brief: `~/.hermes/skills/software-development/design-brief-authoring/references/autonomous-agent-dashboard-brief.md`.
- Repo docs: `README.md`, `MISSION.md`, `STATUS.md`, `ARCH.md`, `TLDR.md` under
  `~/autonomous-agent/`.

## Product Principles

1. **The graph is the product.** Every other surface exists to explain, feed, or
   steer it. Treat graph legibility as the primary quality bar.
2. **One operator, no ceremony.** Optimize for a single trusted user: direct
   control, no multi-tenant scaffolding the operator would have to operate.
3. **Legible state over inferred state.** Show what the system actually knows
   (and mark what it does not — neutral health, undecided facts) rather than
   fabricating telemetry.
4. **Agents are data, configured where used.** A new agent is created and tuned
   in the UI — model, endpoint, tools, skills, MCP, terminal — not in code.
5. **Monochrome and quiet.** The interface recedes; hierarchy comes from
   structure and type, never from decoration or a second color language.
