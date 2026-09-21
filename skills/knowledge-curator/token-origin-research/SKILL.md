---
name: token-origin-research
description: Trace the origin, creation time, and launch platform of a crypto token using public APIs (DexScreener, Blockscout, CoinMarketCap). Use when you need to verify token launch dates, find contract addresses, or investigate memecoin genesis for knowledge-curator work.
---

# Token Origin Research

Use this when you need to trace where a token came from — when it launched, which platform created it, who deployed it.

## Quick reference

| Data | Source | Endpoint |
|---|---|---|
| Contract address + chain | DexScreener search | `api.dexscreener.com/latest/dex/search?q=<SYMBOL>` |
| Pair creation timestamp | DexScreener pair detail | `api.dexscreener.com/latest/dex/pairs/<chain>/<pairAddress>` → `pairCreatedAt` (epoch ms) |
| Token metadata (holders, supply) | Blockscout API | `/api/v2/tokens/<contract>` |
| ATL/ATH dates | CoinMarketCap | `coinmarketcap.com/currencies/<slug>/` |
| Block explorer URL | CoinMarketCap "Contracts" section | Same page, look for explorer link |

## Workflow

1. Search DexScreener by token symbol to get the contract address and chain
2. Get pair details for the creation timestamp: `pairCreatedAt` in epoch ms
3. Convert timestamp: `python3 -c "import datetime; print(datetime.datetime.fromtimestamp(<ms>/1000, tz=datetime.timezone.utc))"`
4. Verify on CoinMarketCap for ATL/ATH dates and explorer URL
5. Check block explorer for holder count and creation tx

## Pitfalls

- DexScreener API returns the most liquid pair first — check it's on the right chain
- Blockscout API paginates from newest transfers first — you need to paginate back to find earliest txs
- CMC ATL date may be the first DEX trade, not the token creation date (token may have been created earlier on testnet or via pre-mainnet launchpads)
