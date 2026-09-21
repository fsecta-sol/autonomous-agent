"""Tests for objective-scoped gap detection.

Run:
    cd apps/agent && .venv/bin/python -m unittest tests.test_gap_scoping -v

The regression this pins: the gap detector used to treat the ENTIRE vault as the
run's agenda. Every open unknown in the graph became one of the run's candidates
(severity `high`, so they crowded out the objective's own gaps), which is how a
Robinhood-memecoin study spent its whole budget on a previous run's Common Crawl
archaeology. Gaps must be scoped to the objective.
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from agent.research import models as M
from agent.research.context import ResearchContext
from agent.research.gaps import DefaultGapDetector


class _Deps:
    """Minimal deps: the detector only reads ctx for scoping when the index is
    unavailable, which we force by pointing VAULT_ROOT at an empty dir."""

    class config:
        debug = False


class TestObjectiveScopedGaps(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="gap-scope-"))
        (self.tmp / "03-Areas/concepts").mkdir(parents=True, exist_ok=True)
        self._env = {k: os.environ.get(k) for k in ("VAULT_ROOT", "AGENT_DATA_DIR")}
        os.environ["VAULT_ROOT"] = str(self.tmp)
        from agent.knowledge import index as kix
        from agent.tools import vault_index

        kix.invalidate()
        vault_index.invalidate()

    def tearDown(self):
        for k, v in self._env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        from agent.knowledge import index as kix
        from agent.tools import vault_index

        kix.invalidate()
        vault_index.invalidate()

    def _ctx(self, *, run_id: str, unknowns: list[dict]) -> ResearchContext:
        return ResearchContext(
            run_id=run_id,
            objective=M.Objective(statement="How to profit on robinhood-chain memecoins, b20 mechanics"),
            iteration=1,
            relevant=[{"id": "robinhood-chain"}, {"id": "memecoin"}],
            open_unknowns=unknowns,
        )

    def test_foreign_unknown_excluded_own_included(self):
        import asyncio

        ctx = self._ctx(
            run_id="run_MINE",
            unknowns=[
                {"id": "common-crawl-foreign", "title": "common crawl",
                 "question": "Common Crawl could not be queried, a fourth archive remains unchecked",
                 "investigations": ["research:run_OLD"]},
                {"id": "status-open-question-mine", "title": "b20 window",
                 "question": "Which b20 launch window is real?",
                 "investigations": ["research:run_MINE"]},
            ],
        )
        gaps = asyncio.run(DefaultGapDetector(_Deps()).detect(ctx))
        unknown_subjects = {g["subject"] for g in gaps if g["kind"] == "unknown"}
        self.assertIn("status-open-question-mine", unknown_subjects)
        self.assertNotIn("common-crawl-foreign", unknown_subjects,
                         "a previous run's unknown must not become this run's candidate")
        joined = " ".join(g.get("suggested_question", "") for g in gaps).lower()
        self.assertNotIn("common crawl", joined)

    def test_coverage_gap_names_an_entity(self):
        import asyncio

        ctx = self._ctx(run_id="run_MINE", unknowns=[])
        gaps = asyncio.run(DefaultGapDetector(_Deps()).detect(ctx))
        cov = [g for g in gaps if g["kind"] == "objective_coverage"]
        self.assertTrue(cov, "an objectively-uncovered entity should surface a gap")
        q = " ".join(g["suggested_question"] for g in cov).lower()
        # it names a real objective entity, not a leftover English word like "absent"
        self.assertIn("b20", q)

    def test_ambiguous_term_is_scoped_to_the_objective_chain(self):
        """`b20` on Base is the EIP-20 precompile standard; on Robinhood Chain it
        is a memecoin. A bare "What is b20?" sent a run down the wrong chain for
        hundreds of iterations, so the derived question must carry the objective's
        own chain anchor."""
        import asyncio

        ctx = self._ctx(run_id="run_MINE", unknowns=[])
        gaps = asyncio.run(DefaultGapDetector(_Deps()).detect(ctx))
        cov = [g for g in gaps if g["kind"] == "objective_coverage"]
        q = " ".join(g["suggested_question"] for g in cov).lower()
        self.assertIn("robinhood-chain", q, "the ambiguous b20 question must be chain-scoped")

        from agent.research.gaps import _scope_anchor, _qualify

        anchor = _scope_anchor("How to profit on Robinhood-chain memecoins, b20/b420")
        self.assertEqual(anchor, "Robinhood-chain")
        self.assertEqual(_qualify("b20", anchor), "What is b20 on Robinhood-chain, and how does it work?")
        # a named token is not force-qualified
        self.assertEqual(_qualify("cashcat", anchor), "What is cashcat and how does it work?")


if __name__ == "__main__":
    unittest.main(verbosity=2)
