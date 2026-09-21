# Classification System — Project & Token Taxonomy

Every project/token gets classified across **4 independent dimensions**:

---

## 1. Category — What type of thing is this?

| Label | Description | Examples |
|---|---|---|
| `memecoin` | Vibe-based, anonymous/no-team, zero utility, community-driven | PEPE, WIF, BONK |
| `defi` | DEX, lending, yield, CDP, money market, aggregator | Uniswap, Aave, Morpho |
| `infrastructure` | L1, L2, rollup, bridge, oracle, middleware, DA | Ethereum, Arbitrum, Chainlink |
| `consumer` | Social, gaming, NFT, metaverse, identity | Lens, Axie Infinity, ENS |
| `tool` | Dev tools, analytics, wallets, automation | Hardhat, Dune, MetaMask |
| `security` | Audits, monitoring, insurance, fraud detection | Trail of Bits, Forta, Nexus Mutual |
| `ai-crypto` | AI agents, inference markets, decentralized compute | Bittensor, Render, Akash |
| `rwa` | Real-world assets, tokenization, commodity-backed | Ondo, Centrifuge, Maker RWA |
| `payment` | Payment rails, stablecoins, remittance | Circle, Stellar, Celo |
| `privacy` | Privacy protocols, mixers, ZK identity | Tornado Cash, Railgun, Aztec |

**If it fits multiple**: pick primary + note secondary in frontmatter as `subcategory:`.

---

## 2. Lifecycle — What stage is it in?

| Stage | Criteria | Signal |
|---|---|---|
| `pre-launch` | Testnet only, no live token, whitepaper stage | Watch, don't trade |
| `launching` | <7 days old, early liquidity formation | Highest risk/reward window |
| `early-growth` | 7-30 days, organic growth, <$50M FDV | Alpha window open |
| `established` | >$50M FDV OR >30 days old, known by market | Alpha closing, momentum trade |
| `mature` | >$500M FDV, blue chip / top 100 | Utility/investment thesis, not alpha |
| `declining` | TVL/volume/price decreasing, holder exodus | Mostly downside — avoid unless catalyst |
| `dead` | $0 liquidity, no activity, abandoned | Purely informational reference |

**Override rules:**
- If FDV > $50M AND age > 30 days → force `established` (cannot be `launching` or `early-growth`)
- If liquidity = $0 → force `dead`
- If price dropped >80% from ATH AND volume declining → flag `declining`

---

## 3. Safety — Risk level (not moral judgment)

| Level | Criteria | Behavior |
|---|---|---|
| `crime` | Confirmed rug, crime ring deployer, ice phishing, same wallet as known scam | Flag with evidence; warn clearly |
| `suspicious` | Red flags: unverified contract, no socials, honeypot mechanics, single owner controls all liquidity | Flag for investigation |
| `high-risk` | Anonymous, unaudited, no code, low liquidity | Default for memecoins; note as speculative |
| `moderate` | Doxxed team OR audited OR >6 months track record | Acceptable risk for allocation |
| `safe` | Doxxed + audited + multi-sig + >1 year track record | Institutional-grade |

**Override:** If `crime` detected, override any `alpha` classification to `dead`.

---

## 4. Alpha Window — Is there a trade opportunity?

| Status | Meaning |
|---|---|
| `alpha` | Genuinely undiscovered — low mentions, low MC, early liquidity |
| `known` | Market aware, some upside left but diminishing |
| `late` | Late stage — mostly exit liquidity risk |
| `dead` | No trade opportunity (dead, crime, or mature utility) |

**Alpha window is NOT a descriptive category** — it's a **time-sensitive trading signal**. It should be *inferred*, not input. Default rules:

- `lifecycle: pre-launch` + `safety: moderate+` → `alpha` (if undiscovered)
- `lifecycle: launching` + `safety: high-risk+` → `alpha`
- `lifecycle: early-growth` + FDV < $50M → `alpha`
- `lifecycle: established` + `category: memecoin` → `late` (memecoin established = late by definition)
- `lifecycle: established` + FDV > $50M → `known` (market knows it)
- `lifecycle: mature` → `late`
- `lifecycle: declining` → `late`
- `lifecycle: dead` → `dead`
- `safety: crime` → `dead`
- `safety: suspicious` → `known` (bisa bangkit or rug, no edge)

---

## Frontmatter format

```yaml
---
category: memecoin         # primary category
subcategory: null          # optional secondary
lifecycle: launching       # pre-launch | launching | early-growth | established | mature | declining | dead
safety: high-risk          # crime | suspicious | high-risk | moderate | safe
alpha-window: alpha        # alpha | known | late | dead
---
```

## What this replaces

OLD → NEW mapping:
- `type: alpha-play` → `category: memecoin` + `lifecycle: launching/early-growth` + `alpha-window: alpha`
- `type: project` → `category: (one of defi/infrastructure/etc.)` + `lifecycle: established/mature`
- `type: hybrid` → Keep `type: hybrid` but add proper lifecycle + alpha-window dimensions
- `type: alpha-play` with FDV > $50M → `category: memecoin` + `lifecycle: established` + `alpha-window: late` (no longer misleading)
