---
name: inbox-writing-standard
description: The required seed-schema format for agent-written inbox entries in the knowledge curator pipeline. Load this skill whenever you need to write a new entry to 00-Inbox/_knowledge/ at a user's request.
---

# Agent Inbox Writing Standard

When the user asks you to "add X to the inbox" — dropping a topic, URL, or chain-name — you MUST **route to the correct inbox** before writing.

## Routing decision (MANDATORY first step)

Determine whether the input is a **project** (specific product/chain/protocol/dapp) or a **concept** (mechanism/idea/dynamic):

| Signals | It's a PROJECT → write to `_projects/` | It's a CONCEPT → write to `_knowledge/` |
|---------|-----------------------------------------|----------------------------------------|
| What it names | A specific chain, protocol, DEX, L1/L2, wallet, token | A mechanism, design pattern, economic dynamic, primitive |
| Examples | `solana`, `uniswap`, `arbitrum`, `robinhood-chain`, `arc-chain`, `aave`, `eigenlayer` | `amm`, `oracle-manipulation`, `mev`, `proof-of-stake`, `account-abstraction`, `fee-market-dynamics` |
| Test question | "Is this a specific product/deployment?" | "Is this a category/mechanism/idea?" |
| Output path | `00-Inbox/_projects/<slug>.md` | `00-Inbox/_knowledge/<slug>.md` |
| Output schema | Project format (see below) | Seed schema (see below) |

**When in doubt, ASK the user** — "This sounds like a specific project. Should I write it as a project note (goes to 02-Projects/) or extract a mechanism/concept from it (goes to 03-Areas/concepts/)?"

**Project-name trap:** If the user just says "add robinhood chain" or "add arc chain" — these are **project names** (specific L1/L2 chains). Route to `_projects/`. Do NOT guess a mechanism slug; the project-researcher skill will do deep research later.

---

## Schema: Concept entries → `00-Inbox/_knowledge/<slug>.md`

For inputs that describe a mechanism/idea/dynamic:

```yaml
concept: <mechanism-slug>
type-hint: <fundamental | system | programming | concept | economy | trading | blockchain | cross-cutting>
why-to-nail: <1-2 sentences — the angle the eventual note must nail; the "why", not the "what">
connects (wire reciprocity): <[[existing-node]], [[...]] this should link to in the graph>
sources to fetch/verify:
- <the item URL the user mentioned, or results of your own research>
- <any canonical source that explains the concept>
note: agent-queued via user inbox (<who asked>). <1-line: what triggered the keep>
```

## Schema: Project entries → `00-Inbox/_projects/<slug>.md`

For inputs that describe a specific project/chain/protocol/dapp:

```yaml
project: <project-slug>
whitepaper: <url-optional>
docs: <url-optional>
code: <github-url-optional>
twitter: @<handle-optional>
other: <comma-separated-urls>

<free text — why interested, key facts, user's framing>
```

Minimal viable entry — just `project:` slug + at least one source URL + user's reason for interest is enough. The project-researcher cron will deep-research later.

---

## Before writing

Research the topic via web/browser tools first. Even if the user didn't provide a URL, look up what they're talking about — you need enough context to populate the required fields. A bare filename with no context will be flagged as noise by the curator or produce a shallow project note.

## Anti-patterns

- Defaulting to `_knowledge/` for everything (this is the exact bug that causes project entries to be rejected).
- Not researching before writing (assuming you know what the topic is about without verifying).
- Writing a mechanism seed for a clear project name (e.g., turning "robinhood chain" into a guessed concept slug).
- Dropping an inbox entry with no content whatsoever.

## Examples

**Good project entry** (robinhood-chain.md → `_projects/`):
```yaml
project: robinhood-chain
whitepaper: https://robinhood.com/us/en/chain/
docs: https://robinhood.com/us/en/chain/
twitter: @RobinhoodCrypto
other: https://www.coindesk.com/markets/2026/07/09/arbitrum-jumps-19-benefitting-from-robinhood-s-usd568-million-onchain-trading-frenzy

Robinhood Chain — Robinhood's L2 blockchain built on Arbitrum Orbit (chainId: 4663).
$568M daily volume in first week, $86M TVL. 10% net protocol revenue to Arbitrum.
Why interested: TradFi→DeFi chain launch pattern, architectural trade-offs, massive user base launching their own chain.
```

**Good concept entry** (arc-chain.md → `_knowledge/`):
```yaml
concept: stablecoin-native-l1
type-hint: blockchain
why-to-nail: Why Circle built a dedicated L1 blockchain purpose-built for stablecoin-native settlement rather than using existing L1s — what constraints forced a new chain design.
connects (wire reciprocity): [[l1-blockchain]], [[stablecoin]], [[usdc]], [[cctp]]
sources to fetch/verify:
- https://www.arc.io
- https://docs.arc.io/
note: agent-queued via user inbox (hilmy pratama). Circle's stablecoin-native L1 with USDC-as-gas.
```
