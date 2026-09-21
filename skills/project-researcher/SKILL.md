---
name: project-researcher
description: Research a specific crypto project (token or chain) by synthesizing on-chain data, documentation, and market signals into a durable project note. Links to the concept graph. Two output types: token (safety-first analysis) and chain/infrastructure (code-level verification). DO NOT store stale market data — project notes are analytic, not a price dashboard.
---

# Project Researcher

## Operating principle

A project note answers **4 questions**: What is this? Is it safe? Why do people buy? What economic value does it have? It does NOT answer "what's the current price?" — that's a live data query, not a durable note.

Stay source-grounded. Every claim about contract behavior, deployer, holder distribution, or volume pattern must be backed by on-chain evidence. Use `crypto-address-forensics` and `evm-contract-forensics` skills as the verification layer.

## When to run

Activated when `00-Inbox/_projects/` contains files. The `process-inbox-projects` cron fires every 30m and invokes this skill.

## Two project types

| Type | Trigger | Focus | Example |
|---|---|---|---|
| **Token** | Memecoin, token, alpha play | Safety + narrative + why-people-buy | CASHCAT, B20, ANSEM |
| **Chain / Infra** | L1, L2, bridge, protocol | Code-level verification, architecture, core claims vs reality | Base, Solana |

## Token vs Chain output

| | Token | Chain / Infra |
|---|---|---|
| **Template** | `02-Projects/TEMPLATE-token.txt` | `02-Projects/TEMPLATE-chain.txt` |
| **Focus** | Safety + narrative + why-people-buy | Code-level verification, architecture, claims vs reality |
| **Key sections** | Safety Assessment, Why People Buy, Economic Analysis | Implementation Reality, Gap Analysis, Advantage Framework, How It Works |
| **Example** | CASHCAT, B20, ANSEM | Base, Solana, Ethereum |

## Hard rules

1. **No stale market data.** Never write price, FDV, liquidity, or volume numbers into the project note. These are live queries — link to DexScreener instead.
2. **Verify before safety claims.** Never claim "same deployer" or "crime ring" from shared address prefixes alone. RPC `eth_getCode`, Blockscout creator, sequential nonces.
3. **Vault first.** Check `03-Areas/concepts/` and `02-Projects/` for existing context before writing.
4. **Classification required.** Every note must have `category`, `lifecycle`, `safety`, `alpha-window` in frontmatter per `CLASSIFICATION.md`.
5. **Link to concepts.** Every note must link to at least 1 concept note (archetype like `[[memecoin-mania]]`, `[[reflexivity]]`, `[[mev]]`, etc.).
6. **Reciprocity.** When linking to existing concepts, ensure reciprocal wikilinks in `## Comparable` — but concept notes about mechanisms, not other projects.
7. **Full addresses only.** No `0x...` truncation. Always 42-character addresses.

## Token Research Workflow

### Phase 1 — Identify Chain & Contract

1. Parse input from `00-Inbox/_projects/` — may contain ticker, URL, or contract address
2. DexScreener search: `curl -s "https://api.dexscreener.com/latest/dex/search?q={query}"`
3. Sort by liquidity → highest = primary pair
4. Confirm chain, contract address, DEX
5. Check for same-ticker tokens on other chains (cross-chain presence)

### Phase 2 — On-Chain Reconnaissance

6. Blockscout API: `GET /api/v2/addresses/{addr}` → is_contract, verified, creator, creation_tx, token info
7. If unverified + factory-deployed (creation_tx = null): check address patterns (CREATE2 suffix, Clanker prefix)
8. If unverified + EOA-deployed: extract bytecode selectors via PUSH4 analysis
9. RPC `eth_getCode` → verify EOA vs contract, detect known protocol patterns
10. Basic holder check: top holders via Blockscout token holders endpoint

### Phase 3 — Safety Assessment

11. Contract verified? → read source for owner functions, mint, pause, tax
12. Honeypot check: basic transfer flow verification (does a swap succeed? check via internal tx tracing)
13. Deployer trace: who created it? sequential nonces? funding source?
14. Liquidity check: LP token burned or held? unlockable?
15. Volume pattern: buy/sell ratio from DexScreener tx counts, check for wash trading (net-zero cyclers)
16. Social check: Twitter presence, account age, engagement quality

### Phase 4 — Narrative & Economic Analysis

17. What's the narrative? (first on chain, cat/dog meme, AI agent, political)
18. Who's buying? (retail vs whale, KOL-driven?)
19. Economic sustainability: pure speculative or any value accrual mechanism?
20. Comparable: what other tokens share this pattern?

### Phase 5 — Write Project Note

21. Use `02-Projects/TEMPLATE-token.txt` as base
22. Fill frontmatter per `CLASSIFICATION.md`
23. Write all sections — no empty sections, put `N/A` or brief note if genuinely nothing
24. Include `📊 Live: {dexscreener_url}` — the ONLY live data reference
25. Save to `02-Projects/{slug}.md`

### Phase 6 — Reciprocity & Cleanup

26. Check concept wikilinks in the note → ensure reciprocal links in concept notes
27. Move input file to `00-Inbox/_processed/YYYY-MM-DD/{basename}.txt`
28. Append daily log entry: "✅ {slug} → project note created (token, safety: {level})"

## Token Project Note Schema

See `02-Projects/TEMPLATE-token.md` for the full template. Required sections:

```markdown
---
category: {memecoin|defi|infrastructure|consumer|...}
lifecycle: {pre-launch|launching|early-growth|established|mature|declining|dead}
safety: {crime|suspicious|high-risk|moderate|safe}
alpha-window: {alpha|known|late|dead}
---

## TLDR
## Identity
## Safety Assessment (table)
## Why People Buy
## Economic Analysis
## Risk Floor
## Comparable
## Notes
📊 Live: {url}
```

## Classification

See `CLASSIFICATION.md` in this skill directory for the full taxonomy:
- `category` — what type of thing (memecoin, defi, infra, etc.)
- `lifecycle` — what stage (launching → dead)
- `safety` — risk level (crime → safe)
- `alpha-window` — trade opportunity (alpha → dead)

## Anti-patterns

- **Price/FDV/liq in markdown.** Stale instantly. Use `📊 Live:` link.
- **"Current state" table.** Same — just ratios in TLDR at most, with timestamp.
- **Same deployer from address prefix.** Verify via creation tx.
- **Empty sections.** If genuinely nothing, write `N/A` — don't leave blank.
- **No concept link.** Every project note should touch at least 1 concept for graph integration.
- **Hardcoding DexScreener prices.** DexScreener is for discovery. Use API responses to derive analysis (ratios), not to copy raw numbers.
- **No safety verdict.** Every token note MUST have a clear safety verdict with evidence table.

## Example: CASHCAT

See `02-Projects/cashcat.md` for the live example using this format.

## Reference skills

Load these skills when doing on-chain verification:
- `crypto-address-forensics` — address verification, deployer tracing, factory detection
- `evm-contract-forensics` — bytecode analysis, method mapping, pump forensics

## Closing

A project note is a **durable analytic artifact** — it should still make sense 6 months later. Numbers change, analysis doesn't. Stay in the analysis layer, link to live data for numbers, and keep the why sharp.
