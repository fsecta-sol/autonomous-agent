---
name: concept-inflation-detection
description: Detect and filter concept inflation when creating knowledge-graph entries — specification numbers (EIP/ERC), product names, and other non-mechanism nouns that should not become standalone concept notes.
---

# Concept Inflation Detection

Concept inflation is creating notes for terms that are not mechanisms — specification numbers, product names, deployment instances, or named standards that duplicate an existing mechanism note.

## The test

Before writing any concept note, ask: **"Is this a noun of a mechanism/idea/dynamic, or a noun of a product/specification/deployment?"**

| Input | Verdict | Why |
|---|---|---|
| `eip-2771` | REJECT — spec cross-ref | Mechanism (meta-transaction) already exists as [[meta-transaction]] |
| `eip-7579` | REJECT — spec cross-ref | Execution interface adopted by [[erc-7710-delegation]]; not a standalone mechanism |
| `erc-8226` | REJECT — spec cross-ref | Identity-bound spend mandate; compare with [[token-level-access-control]] which covers the general pattern |
| `eip-4844` | REJECT — spec cross-ref | Blob transaction mechanism is part of [[ethereum-scaling]] and [[data-availability]] |
| `uniswap` | REJECT — product name | AMM mechanism is [[automated-market-maker]]; Uniswap is an instance, not a concept |
| `ethereum` | REJECT — product/chain name | L1 architecture is [[l1-blockchain]]; Ethereum is a specific deployment |
| `meta-transaction` | ACCEPT — mechanism | Describes the why/how of off-chain intent → on-chain execution relay |
| `mev` | ACCEPT — mechanism | Describes the economic dynamic of value extraction from transaction ordering |

## When filtering during graph-walk or knowledge-curator

1. If the candidate concept matches an EIP/ERC number pattern, grep the vault for existing notes that describe the underlying mechanism
2. If any existing note already covers the mechanism's "why" and "how", skip the spec ref
3. If the input is purely about a specific project/token, extract the underlying mechanism as the concept and mention the project as an in-body example
4. Record skipped refs in the daily log with reasoning so the human curator can verify

## Why it matters

A concept note named `eip-2771` would be a page about a standard interface — useful for reference but not for compound understanding. The mechanism (meta-transaction relay with trusted forwarders) is what generates edge. Creating spec-number notes inflates the graph with specification nodes instead of mechanism nodes, making the graph harder to navigate without adding insight.
