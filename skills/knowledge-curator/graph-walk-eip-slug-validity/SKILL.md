---
name: graph-walk-eip-slug-validity
description: Guidance on when EIP/ERC-numbered slugs are valid concept nouns (not project-name inflation) for graph-walk and knowledge-curator tasks. Prevents false-negative rejection of interface-specification concepts like eip-2771, eip-7579, eip-712, eip-1271.
---

# EIP/ERC Slug Validity for Graph Walk

## The pattern that produced this skill

Previous graph-walk runs rejected dangling refs like `eip-2771` and `eip-7579` as "spec numbers, not mechanism nouns" — only to reverse that assessment in later runs after recognizing that the vault already contains analogous numbered-spec concepts ([[eip-712]], [[eip-1271]], [[eip-2612]], [[eip-4788]]). The false negative is caused by treating all numbered spec slugs as project-name inflation rather than recognizing that EIPs/ERCs can describe concrete interface mechanisms.

## The test — not whether it has a number, but whether it names a mechanism

| Valid (numbered spec = mechanism) | INVALID (numbered spec = project/deployment) |
|---|---|
| `eip-2771` — defines Forwarder↔Recipient interface, `isTrustedForwarder()`, `_msgSender()` extraction | A spec that simply registers an ERC number for "ProjectName Token" without defining a novel interface mechanism |
| `eip-7579` — defines bytes32 execution mode encoding for modular smart accounts | A spec that assigns an ERC number to an existing standard with no additional mechanism |
| `eip-712` — defines typed structured data hashing/signing scheme | |
| `eip-1271` — defines `isValidSignature` interface | |
| `eip-2612` — defines permit-based approval interface | |

## Decision procedure

1. Check the content of the spec. Does it define **function signatures**, **interface semantics**, **encoding schemes**, or **architectural constraints**? If yes, it names a mechanism — valid concept.
2. Does the vault already have analogous numbered-spec concepts at the same layer? If eip-712/eip-1271/eip-2612/eip-4788 exist, a new numbered-spec that passes test (1) should also exist.
3. Is the slug purely a registrant name (e.g., "eip-1234: ProjectName") with no novel interface? Reject — flag `[REJECT-PROJECT]`.

## Heuristic: the meta-transaction test

If the concept note that references the dangling slug describes it as "the canonical specification for [mechanism]" in a `Related` or `Builds on` section, the slug is a valid mechanism concept. The referencing note is already telling you what the mechanism is — create the concept note for it.
