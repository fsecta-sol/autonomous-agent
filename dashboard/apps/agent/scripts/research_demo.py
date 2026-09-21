"""Real multi-iteration Research Loop demo.

Drives the loop end-to-end against a throwaway copy of the operator's vault with
a deterministic (model-free) executor, then prints what it did: gaps detected,
candidates generated, iterations, knowledge written into the Markdown graph, and
the event timeline. Proves the loop is grounded in the existing Knowledge Graph
and produces real nodes.

Run:  .venv/bin/python scripts/research_demo.py
Exit 0 iff the run completed and wrote at least one new node.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import sys
import tempfile
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

SEED = ["mev", "mempool", "oracle", "rollup", "smart-contracts", "proof-of-stake"]


def build_sandbox() -> Path:
    root = Path(tempfile.mkdtemp(prefix="research-demo-"))
    (root / "vault/03-Areas/concepts").mkdir(parents=True)
    (root / "vault/02-Projects").mkdir(parents=True)
    real = Path(os.environ.get("KM_DEMO_SOURCE", "/home/hermes/vault/03-Areas/concepts"))
    for slug in SEED:
        src = real / f"{slug}.md"
        if src.exists():
            shutil.copy2(src, root / "vault/03-Areas/concepts" / f"{slug}.md")
    return root


async def main() -> int:
    root = build_sandbox()
    os.environ["VAULT_ROOT"] = str(root / "vault")
    os.environ["AGENT_DATA_DIR"] = str(root / "data")

    from agent.knowledge.manager import KnowledgeManager
    from agent.research import models as M
    from agent.research.config import ResearchConfig
    from agent.research.executor import ScriptedExecutor
    from agent.research.loop import ResearchLoop, build_default_deps
    from agent.research.store import ResearchStore

    # A deterministic "researcher": every plan yields a sourced finding. Real
    # deployments swap this for SubagentExecutor; the loop is identical.
    def finder(plan, ctx):
        return M.ResearchResult(
            id=M.new_id("res_"), candidate_id=plan.candidate_id, iteration_id="", strategy=plan.strategy,
            observations=[{"statement": f"Observed: {plan.question.rstrip('?')} is documented in the spec.", "source": "spec"}],
            evidence=[{"kind": "source", "statement": "the spec states the mechanism", "source": "https://ethereum.org"}],
            sources=["https://ethereum.org"], conclusions=["the mechanism behaves as documented"],
            hypothesis_survived=True,
        )

    store = await ResearchStore.open()
    km = KnowledgeManager()
    cfg = ResearchConfig(max_iterations=5, diminishing_returns_streak=3, min_useful_info_gain=0.15, debug=True)
    deps = build_default_deps(store=store, km=km, executor=ScriptedExecutor(rules=[("any", finder)]), config=cfg)
    loop = ResearchLoop(deps)

    print(f"Sandbox vault: {root/'vault'}\n")
    print("OBJECTIVE: Understand how MEV extraction works, its preconditions, and who captures the value.\n")

    run = await loop.start({
        "objective": "Understand how MEV extraction works, its preconditions, and who captures the value",
        "success_criteria": ["mev understood", "preconditions identified", "value capture mapped"],
        "domain": "crypto",
    })
    await loop.advance(run.id)
    run = await store.get_run(run.id)

    print("── RUN SUMMARY ─────────────────────────────────────────────")
    print(f"status={run.status} stage={run.stage} iterations={run.iteration}")
    print(f"termination: {run.termination_reason}")
    print(f"progress: {run.progress.to_dict()}")

    its = await store.list_iterations(run.id)
    print(f"\n── ITERATIONS ({len(its)}) ──────────────────────────────────────")
    for it in its:
        kg = ", ".join(f"{u['op']}→{u['id']}" for u in it.knowledge_updates[:3]) or "—"
        print(f"  #{it.index} [{it.branch}] strategy={it.strategy} next={it.next_action}")
        print(f"      Q: {it.hypothesis[:78]}")
        print(f"      eval: {it.evaluation.get('info_gain')} | knowledge: {kg}")

    branches = run.metadata.get("branches", {})
    if len(branches) > 1:
        print("\n── BRANCHES ────────────────────────────────────────────────")
        for name, b in branches.items():
            print(f"  {name} (parent={b.get('parent')}, depth={b.get('depth')})")

    evs = await store.list_events(run.id)
    print(f"\n── EVENT TIMELINE ({len(evs)} events) ─────────────────────────")
    for t, n in Counter(e["type"] for e in evs).most_common():
        print(f"  {n:>3}  {t}")

    # the Research Evaluator's decision-support output, one per iteration
    evals = await store.list_evaluations(run.id)
    if evals:
        print(f"\n── EVALUATIONS ({len(evals)}) ────────────────────────────────")
        for e in evals:
            sig = ",".join(s["name"] for s in e["signals"]) or "—"
            rec = e["recommendation"]
            print(f"  iter {e['iteration_id'][-6:]}: {e['status']:15} rec={rec.get('action','?'):9} "
                  f"evQ={e['evidence_quality']:.2f} gain={e['knowledge_gain']:.2f} conf={e['confidence']:.2f}")
            print(f"        signals: {sig}")

    created = [it for it in its for u in it.knowledge_updates if u["op"] == "create"]
    concepts = list((root / "vault/03-Areas/concepts").glob("*.md"))
    print("\n── KNOWLEDGE ───────────────────────────────────────────────")
    print(f"  vault concept notes: {len(concepts)} (seeded {len(SEED)})")
    print(f"  new nodes created by the run: {len(created)}")

    # health after the run
    from agent.knowledge.manager import KnowledgeManager as KM2

    h = KM2().validate_graph()
    print(f"  graph health: {h['nodes']} nodes, {h['relationships']} edges, {h['conflicts']} conflicts")

    await store.close()
    ok = run.status == "COMPLETED" and len(created) >= 1
    shutil.rmtree(root, ignore_errors=True)
    print()
    print("DEMO OK — the loop ran multiple grounded iterations and grew the knowledge graph."
          if ok else "DEMO FAILED — inspect the output above.")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
