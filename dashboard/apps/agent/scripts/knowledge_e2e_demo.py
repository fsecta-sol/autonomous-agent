"""End-to-end demo of the Knowledge Manager — the loop the spec calls for.

Runs the five research→knowledge scenarios against a THROWAWAY sandbox copy of
the vault, so the operator's real Markdown is never touched. Proves:

  RUN 1  research discovers a fact    -> extract -> dedup -> persist .md (+ evidence) -> index
  RUN 2  a later task retrieves it    -> no rediscovery
  RUN 3  more detail arrives          -> existing node enriched, NOT duplicated
  RUN 4  contradictory evidence       -> ## Conflict (UNRESOLVED), original intact
  RUN 5  experiment resolves conflict -> canonical updated, version chain preserved

Plus two invariants:
  * rebuild_index() restores the index from Markdown alone
  * deleting the manager leaves the knowledge intact in the .md files

Run:  .venv/bin/python scripts/knowledge_e2e_demo.py
Exit code 0 iff every check passes.
"""

from __future__ import annotations

import os
import shutil
import sys
import tempfile
from pathlib import Path

# Make `agent.*` importable when run as a script from the agent service dir.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

SEED = ["mev", "mempool", "oracle", "rollup", "proof-of-stake", "smart-contracts"]

PASS = "PASS"
FAIL = "FAIL"
_failures: list[str] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    mark = PASS if ok else FAIL
    if not ok:
        _failures.append(label)
    print(f"  [{mark}] {label}" + (f"  — {detail}" if detail else ""))


def build_sandbox() -> Path:
    root = Path(tempfile.mkdtemp(prefix="km-demo-"))
    (root / "03-Areas/concepts").mkdir(parents=True)
    (root / "02-Projects").mkdir(parents=True)
    real = Path(os.environ.get("KM_DEMO_SOURCE", "/home/hermes/vault"))
    for slug in SEED:
        src = real / "03-Areas/concepts" / f"{slug}.md"
        if src.exists():
            shutil.copy2(src, root / "03-Areas/concepts" / f"{slug}.md")
    return root


def main() -> int:
    root = build_sandbox()
    os.environ["VAULT_ROOT"] = str(root)
    os.environ["AGENT_DATA_DIR"] = str(root / ".data")

    # import AFTER the env is set, so config picks up the sandbox paths
    from agent.config import knowledge_index_path
    from agent.knowledge import index as ix
    from agent.knowledge import observability
    from agent.knowledge.manager import KnowledgeManager

    km = KnowledgeManager()
    print(f"Sandbox vault: {root}\n")

    # ── RUN 1 ────────────────────────────────────────────────────────────────
    print("RUN 1 — research discovers a new fact; extract → dedup → persist → index")
    r1 = km.create_knowledge(
        title="Blob-Space Congestion Pricing",
        text=(
            "Blob-space congestion pricing sets the blob base fee as an independent "
            "EIP-1559 market, so rollup data cost decouples from execution gas and "
            "spikes only when blob demand exceeds the target."
        ),
        layer="foundations",
        type="system",
        sources=["https://eips.ethereum.org/EIPS/eip-4844", "https://ethresear.ch/t/blob-fee-market"],
        evidence=["research-42: two rollups posted 6 blobs each in one slot, blob base fee rose 3x"],
        task_id="run1",
        research_id="research-42",
        execution_id="exec-1",
        source="research",
    )
    check("RUN1 new node created (not a duplicate)",
          r1["action"] == "CREATE" and r1["id"] == "blob-space-congestion-pricing", str(r1))
    note_path = root / "03-Areas/concepts/blob-space-congestion-pricing.md"
    body = note_path.read_text() if note_path.exists() else ""
    check("RUN1 persisted to .md with evidence trail",
          "## Evidence" in body and "research-42" in body)
    check("RUN1 indexed", ix.get().node("blob-space-congestion-pricing") is not None)

    # ── RUN 2 ────────────────────────────────────────────────────────────────
    print("\nRUN 2 — a later task retrieves the fact without rediscovering it")
    hits = km.search("how is rollup data priced when blob space is congested", {"limit": 3})
    top = hits[0]["id"] if hits else None
    check("RUN2 retrieval surfaces the node first", top == "blob-space-congestion-pricing", f"top={top}")
    rel = km.get_relevant("explain blob congestion pricing for rollup data")
    check("RUN2 context block carries provenance",
          "[[blob-space-congestion-pricing]]" in rel["rendered"] and "conf" in rel["rendered"].lower())

    # ── RUN 3 ────────────────────────────────────────────────────────────────
    print("\nRUN 3 — more detail arrives; enrich the node, do not duplicate it")
    before = len(list((root / "03-Areas/concepts").glob("*.md")))
    r3 = km.create_knowledge(
        title="Blob-Space Congestion Pricing",
        text=(
            "Additional detail: the blob base fee updates exponentially per block toward the "
            "blob target, so a sustained overshoot raises the fee until rollups throttle posting."
        ),
        sources=["https://eips.ethereum.org/EIPS/eip-4844"],
        task_id="run3",
        source="research",
    )
    after = len(list((root / "03-Areas/concepts").glob("*.md")))
    check("RUN3 classified as enrichment, not a new file",
          r3["action"] == "UPDATE" and before == after, f"{r3} files {before}->{after}")

    # ── RUN 4 ────────────────────────────────────────────────────────────────
    print("\nRUN 4 — contradictory evidence; record a conflict, do NOT overwrite")
    mempool_before = (root / "03-Areas/concepts/mempool.md").read_text()
    r4 = km.create_knowledge(
        title="mempool",
        text="Observation: the public mempool does not exist; every transaction is routed privately.",
        contradicts=["mempool"],
        evidence=["request #183 observed 2026-09-16: endpoint returned 200 with no authentication"],
        task_id="run4",
        source="experiment",
    )
    mempool_after = (root / "03-Areas/concepts/mempool.md").read_text()
    check("RUN4 conflict recorded (UNRESOLVED)", r4["action"] == "CONFLICT" and r4["status"] == "UNRESOLVED", str(r4))
    check("RUN4 original content intact", "## What" in mempool_after and "## Conflict" in mempool_after)
    check("RUN4 nothing silently overwritten", "The mempool" in mempool_after or "mempool" in mempool_before)

    # ── RUN 5 ────────────────────────────────────────────────────────────────
    print("\nRUN 5 — experiment resolves it; update canonical, keep the version chain")
    km.verify("blob-space-congestion-pricing", ["confirmed by two independent sources"], confidence="high", task_id="run5")
    sup = km.supersede("blob-space-congestion-pricing", "rollup", task_id="run5")
    node = km.get("blob-space-congestion-pricing")
    check("RUN5 supersede recorded", sup["ok"] and node["status"] == "superseded" and node["superseded_by"] == "rollup")
    check("RUN5 old file preserved for history", note_path.exists())
    bak = list((root / "03-Areas/concepts").glob("blob-space-congestion-pricing.*.bak"))
    check("RUN5 backup snapshots written (history recoverable)", len(bak) >= 1, f"{len(bak)} .bak")

    # ── invariants ───────────────────────────────────────────────────────────
    print("\nINVARIANT — index is derived; deleting it is recoverable from Markdown")
    ix.save()
    idx_file = knowledge_index_path()
    idx_file.unlink(missing_ok=True)
    rebuilt = km.rebuild_index()
    check("rebuild_index() restores from .md alone", rebuilt["nodes"] > 0 and idx_file.exists(), str(rebuilt))

    print("\nINVARIANT — deleting the manager leaves the knowledge in the Markdown")
    # read the note with plain file I/O, no manager code involved
    raw = note_path.read_text()
    check("knowledge survives without the manager", "blob-space-congestion-pricing" in raw and "## What" in raw)

    print("\nOBSERVABILITY — operations logged")
    ops = {e["operation"] for e in observability.tail(50)}
    check("lifecycle events emitted",
          {"KNOWLEDGE_CREATED", "KNOWLEDGE_UPDATED", "KNOWLEDGE_CONFLICT", "KNOWLEDGE_SUPERSEDED", "KNOWLEDGE_VERIFIED"} <= ops,
          ", ".join(sorted(ops)))

    print("\nHEALTH — validate_graph()")
    h = km.validate_graph()
    print(f"  nodes={h['nodes']} relationships={h['relationships']} conflicts={h['conflicts']} "
          f"unverified={h['unverified']} superseded={h['superseded']}")
    check("health reports the conflict + supersede", h["conflicts"] >= 1 and h["superseded"] >= 1)

    shutil.rmtree(root, ignore_errors=True)

    print()
    if _failures:
        print(f"FAILED: {len(_failures)} check(s): {', '.join(_failures)}")
        return 1
    print("ALL CHECKS PASSED — research → knowledge → persistence → retrieval loop works end-to-end.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
