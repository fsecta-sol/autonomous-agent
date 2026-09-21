---
name: evm-on-chain-forensics
description: Reference for EVM on-chain token forensics using Blockscout API, RPC verification, and EOA/Contract classification.
---

# EVM On-Chain Forensics Reference

## Data Sources (EVM chains)

| Chain | Blockscout API | Etherscan API | Public RPC |
|---|---|---|---|
| Base | base.blockscout.com/api/v2 | etherscan.io/v2/api?chainid=8453 (paid) | mainnet.base.org |
| Ethereum | — | etherscan.io/v2/api?chainid=1 (free) | Various |
| Arbitrum | — | etherscan.io/v2/api?chainid=42161 (free) | Various |

## Blockscout API — Free EVM Data

**Endpoint**: `https://base.blockscout.com/api/v2/tokens/<contract>/transfers`

- 50 items/page, newest-first, cursor pagination via next_page_params
- Each item has `from.is_contract` and `to.is_contract` — direct EOA/Contract classification
- Crawl with 1-1.5s delays to avoid timeout on spike periods

**Other endpoints**:
- `GET /tokens/<contract>` — token metadata
- `GET /tokens/<contract>/holders` — holder list
- `GET /addresses/<address>` — creator and creation tx

## RPC Verification (Base)

**Endpoint**: `mainnet.base.org`

- `eth_getCode`: `"0x"` = EOA, bytecode = Contract
- `eth_getLogs`: Transfer event `0xddf252ad...`, limited to ~10K block range
- Contract ID via selectors: `0x8da5cb5b` (owner), `0x22c0d9f` (swap)

## Forensic Workflow

1. Get CA + chain from DexScreener
2. Fetch all transfers from Blockscout API
3. Classify addresses via `is_contract` field
4. Verify suspicious contracts via RPC `eth_getCode` + function selectors
5. Detect patterns: dominant contracts, net-zero bots, wash trading

## Pitfalls

- Shared CA prefix = factory/CREATE2 pattern, NOT same deployer
- Blockscout deep pagination timeouts on high-volume tokens
- Free Base RPC only has recent ~1.5K blocks of log data
