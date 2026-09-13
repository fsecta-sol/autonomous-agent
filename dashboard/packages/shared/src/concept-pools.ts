import type { Layer, NodeType } from "./types";

export const CRYPTO = [
  "Elliptic Curve Signatures", "ECDSA", "Schnorr Signatures", "BLS Signature Aggregation", "Merkle Tree",
  "Merkle Patricia Trie", "Verkle Tree", "Zero-Knowledge Proof", "ZK-SNARK", "ZK-STARK", "Commitment Scheme",
  "Pedersen Commitment", "KZG Polynomial Commitment", "Threshold Signature Scheme", "Multi-Party Computation",
  "Homomorphic Encryption", "Nullifier Scheme", "Ring Signature", "Verifiable Random Function", "Fiat-Shamir Heuristic",
  "Hash Preimage Resistance", "Collision Resistance", "Signature Malleability", "Key Derivation Function",
];

export const FOUNDATIONS = [
  "Public Key Cryptography", "Nonce", "UTXO Model", "Account Model", "Gas Mechanism",
  "EIP-1559 Fee Market", "Mempool", "Block Header", "Consensus Mechanism", "Proof of Work", "Proof of Stake",
  "Nakamoto Consensus", "BFT Consensus", "Finality", "Fork Choice Rule", "Chain Reorganization", "Longest Chain Rule",
  "Validator Set", "Slashing Condition", "Staking Reward", "Unbonding Period", "Genesis Block", "State Root",
  "Transaction Pool", "Signature Verification", "Address Derivation", "Wallet Key Management", "Seed Phrase",
  "HD Wallet Derivation", "Multisig Wallet", "Smart Contract", "EVM Opcode", "Gas Limit", "Block Time",
  "Difficulty Adjustment", "Light Client", "Full Node", "Archive Node", "State Sync", "Snapshot Sync",
  "Node Discovery Protocol", "Block Production", "Transaction Ordering", "Replay Protection", "Chain ID Isolation",
];

export const PLATFORMS = [
  "L1 Blockchain", "L2 Rollup", "Optimistic Rollup", "ZK Rollup", "Rollup Fraud Proof",
  "Rollup Validity Proof", "Data Availability Layer", "Data Availability Sampling", "Danksharding", "Blob Transaction",
  "Modular Blockchain Stack", "Monolithic Blockchain", "Shared Sequencer", "Sequencer Decentralization",
  "Proposer-Builder Separation", "MEV-Boost Relay", "Based Rollup", "Based Preconfirmation", "App-Chain", "Cosmos IBC",
  "Sovereign Rollup", "Bridge Contract", "Cross-Chain Messaging", "Light Client Bridge", "Optimistic Bridge",
  "Canonical Bridge", "Wrapped Asset", "Atomic Swap", "Interoperability Layer", "Restaking Protocol", "EigenLayer AVS",
  "Liquid Staking Protocol", "Liquid Staking Derivative", "Validator Client", "Execution Client", "Consensus Client",
  "Node Operator", "RPC Provider", "Indexer Protocol", "Subgraph Indexing", "Oracle Network", "Price Feed Oracle",
  "Cross-Chain Oracle", "Keeper Network", "Automation Network", "Account Abstraction", "ERC-4337", "Smart Account",
  "Paymaster", "Bundler", "Intent-Based Execution", "Solver Network", "Order Flow Auction", "Private Mempool",
  "MEV Relay", "Builder Market", "Block Builder", "Searcher Bot", "Encrypted Mempool", "Threshold Encryption Mempool",
  "Shared Sequencing Layer", "Rollup-as-a-Service", "App-Specific Rollup", "Sidechain", "Plasma Chain", "State Channel",
  "Payment Channel Network", "Validium", "Volition", "Fuel VM", "Move VM", "SVM Parallel Execution",
  "Optimistic Concurrency Control", "Sharding", "Beacon Chain", "Attestation Aggregation", "Sync Committee",
  "Blob Fee Market", "Preconfirmation Protocol", "Rollup Exit Queue", "Cross-Rollup Messaging", "Superchain Interop",
  "Native Yield Rollup", "Shared Bridging Layer", "Sequencer Fee Market", "Validator Client Diversity",
];

export const APPLICATIONS = [
  "Automated Market Maker", "Constant Product AMM", "Concentrated Liquidity", "Stableswap Curve",
  "Orderbook DEX", "Perpetual DEX", "Perpetual Futures", "Funding Rate Mechanism", "Funding Rate Arbitrage",
  "Options Vault Strategy", "Structured Product Vault", "Lending Protocol", "Overcollateralized Lending",
  "Undercollateralized Credit", "Isolated Lending Market", "Interest Rate Model", "Liquidation Mechanism",
  "Liquidation Cascade", "Dutch Auction Liquidation", "Collateralized Debt Position", "Stablecoin Peg Mechanism",
  "Algorithmic Stablecoin", "Overcollateralized Stablecoin", "Real World Asset Tokenization", "Yield Aggregator",
  "Yield Farming", "Liquidity Mining", "Impermanent Loss", "Impermanent Loss Hedge", "Flash Loan",
  "Flash Loan Arbitrage", "DEX Aggregator", "Cross-DEX Routing", "NFT Marketplace Mechanism", "NFT Royalty Enforcement",
  "Fractionalized NFT", "Prediction Market", "Insurance Protocol Cover", "Perp DEX Insurance Fund",
  "DAO Treasury Management", "Governance Vote Escrow", "Ve-Tokenomics", "Quadratic Voting", "Bonding Curve",
  "Bonding Curve AMM", "Token Launchpad", "Fair Launch Mechanism", "Liquidity Bootstrapping Pool",
  "Vault Auto-Compounding", "Cross-Margin Account",
];

export const MARKET = [
  "Memecoin", "Memecoin Launch Mechanics", "Token Vesting Schedule", "Token Unlock Cliff",
  "Market Maker Agreement", "Order Book Depth", "Slippage", "Price Impact", "Arbitrage Bot",
  "Cross-Exchange Arbitrage", "Triangular Arbitrage", "Basis Trade", "Cash and Carry Trade",
  "Perpetual Funding Arbitrage", "Copy Trading", "Social Trading Platform", "On-Chain Analytics", "Wallet Clustering",
  "Whale Watching", "Smart Money Tracking", "Token Distribution Analysis", "Airdrop Farming", "Sybil Resistance",
  "Points Program", "Retroactive Airdrop", "Market Cycle", "Liquidity Crunch", "Rug Pull Pattern", "Honeypot Contract",
  "Pump and Dump Pattern", "Insider Trading Detection", "Vesting Overhang", "Circulating Supply Dynamics",
  "Fully Diluted Valuation", "Token Unlock Sell Pressure", "Perp Open Interest Skew", "Funding Rate Signal",
  "Narrative Rotation",
];

export const CROSSCUT = [
  "MEV", "Sandwich Attack", "Frontrunning", "Backrunning", "Just-In-Time Liquidity", "Toxic Order Flow",
  "Censorship Resistance", "Credible Neutrality", "Regulatory Compliance Layer", "KYC/AML Gate",
  "Privacy-Preserving Compliance", "Verifiable Agent Computation", "Autonomous Agent Custody",
  "Agent Wallet Permissions", "On-Chain Reputation", "Decentralized Identity", "Soulbound Token",
  "Governance Attack Vector", "Flash Loan Governance Attack", "Oracle Manipulation Attack",
  "Economic Security Budget", "Cross-Domain MEV", "Latency Arbitrage", "Trust-Minimized Bridging",
];

export const LAYER_COUNTS: Record<Layer, number> = {
  cryptography: 21,
  foundations: 42,
  platforms: 80,
  applications: 47,
  market: 35,
  "cross-cutting": 21,
};

export const TYPE_COUNTS: Record<NodeType, number> = {
  system: 78,
  fundamental: 48,
  economy: 30,
  programming: 26,
  concept: 26,
  "cross-cutting": 19,
  trading: 10,
  blockchain: 9,
};

export const LAYERS = Object.keys(LAYER_COUNTS) as Layer[];
export const TYPES = Object.keys(TYPE_COUNTS) as NodeType[];

export const POOLS: Record<Layer, string[]> = {
  cryptography: CRYPTO,
  foundations: FOUNDATIONS,
  platforms: PLATFORMS,
  applications: APPLICATIONS,
  market: MARKET,
  "cross-cutting": CROSSCUT,
};
