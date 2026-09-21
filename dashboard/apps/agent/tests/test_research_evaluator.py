"""Tests for the Modular Research Evaluator.

Run:
    cd apps/agent && .venv/bin/python -m unittest tests.test_research_evaluator -v

Covers: evidence taxonomy + strength grading, source quality, the dimension
scores, contradiction + redundancy detection, failure quality, status derivation,
signal emission, recommendation mapping, the optional LLM judge's clamping, and an
end-to-end evaluation driven through the real loop (persistence included).

Deterministic and model-free; the LLM judge is exercised with a stub callable.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from agent.research import models as M
from agent.research.context import ResearchContext
from agent.research.evaluator import EvaluationInput, ResearchEvaluator
from agent.research.evaluator import evidence as E
from agent.research.evaluator import model as EM
from agent.research.evaluator.base import DIMENSION_REGISTRY
from agent.research.evaluator.llm import CallableJudge, NoopJudge, apply_adjustments


def _run(objective="Understand how MEV extraction works", criteria=None) -> M.ResearchRun:
    return M.ResearchRun(id="run1", objective=M.Objective(statement=objective, success_criteria=criteria or []))


def _ctx(run: M.ResearchRun) -> ResearchContext:
    return ResearchContext(run_id=run.id, objective=run.objective, iteration=1)


def _result(**kw) -> M.ResearchResult:
    base = {
        "id": "res1",
        "candidate_id": "cand1",
        "iteration_id": "iter1",
        "strategy": "documentation",
        "question": "Does endpoint X require auth for market data?",
    }
    base.update(kw)
    return M.ResearchResult(**base)


class TestEvidenceTaxonomy(unittest.TestCase):
    def test_levels_are_classified(self):
        # a concrete, first-hand statement → OBSERVATION
        lvl, _ = E.classify_level("GET /v2/markets returned HTTP 200 without an Authorization header", kind="observation")
        self.assertEqual(lvl, EM.LEVEL_OBSERVATION)
        # hedged language → INTERPRETATION
        lvl, _ = E.classify_level("the endpoint appears to be public", kind="source")
        self.assertEqual(lvl, EM.LEVEL_INTERPRETATION)
        # hedge + connective → INFERENCE
        lvl, _ = E.classify_level("the frontend therefore likely uses X for market rendering")
        self.assertEqual(lvl, EM.LEVEL_INFERENCE)
        # explicitly a conclusion
        lvl, _ = E.classify_level("Market rendering depends on endpoint X", is_conclusion=True)
        self.assertEqual(lvl, EM.LEVEL_CONCLUSION)
        # empty → UNSUPPORTED
        lvl, _ = E.classify_level("")
        self.assertEqual(lvl, EM.LEVEL_UNSUPPORTED)

    def test_conclusion_never_stronger_than_evidence(self):
        # a strong observation, a conclusion with no support → conclusion WEAK/UNSUPPORTED
        r = _result(
            observations=[{"statement": "curl -i https://x/api returned 200 with a prices array", "source": "https://x/api"}],
            conclusions=["X definitely requires no auth and is safe to call in prod"],
        )
        a = E.assess(r)
        concl = [x for x in a if x.level == EM.LEVEL_CONCLUSION]
        self.assertTrue(concl)
        # the conclusion cannot be DIRECT/CORROBORATED just because its prose is confident
        self.assertIn(concl[0].strength, (EM.STRENGTH_WEAK, EM.STRENGTH_UNSUPPORTED, EM.STRENGTH_INDIRECT))
        self.assertLessEqual(concl[0].value, EM.STRENGTH_VALUE[EM.STRENGTH_DIRECT])

    def test_corroboration_upgrades_strength(self):
        r = _result(
            observations=[
                {"statement": "the markets endpoint returned a prices array of 42 entries", "source": "https://a.example"},
                {"statement": "the markets endpoint returned a prices array with 42 entries", "source": "https://b.example"},
            ],
        )
        a = E.assess(r)
        self.assertTrue(any(x.strength == EM.STRENGTH_CORROBORATED for x in a), [x.strength for x in a])

    def test_evidence_quality_penalises_unsupported(self):
        strong = E.assess(_result(evidence=[{"kind": "experiment", "statement": "measured 12ms p50 latency", "source": "https://x"}]))
        q_strong, _ = E.evidence_quality(strong)
        mixed = strong + [EM.EvidenceAssessment(evidence_id="z", strength=EM.STRENGTH_UNSUPPORTED, value=0.1)]
        q_mixed, _ = E.evidence_quality(mixed)
        self.assertGreater(q_strong, q_mixed)


class TestSourceQuality(unittest.TestCase):
    def test_tiers(self):
        high, _ = E.source_tier("https://eips.ethereum.org/EIPS/eip-1559")
        gov, _ = E.source_tier("https://nist.gov/publication")
        low, _ = E.source_tier("https://x.com/someone/status/123")
        none, _ = E.source_tier("")
        self.assertGreater(high, low)
        self.assertGreater(gov, low)
        self.assertEqual(none, 0.0)

    def test_diversity_bonus(self):
        one_domain = E.source_quality(["https://a.example/1", "https://a.example/2"])[0]
        two_domains = E.source_quality(["https://a.example/1", "https://b.example/2"])[0]
        self.assertGreaterEqual(two_domains, one_domain)


class TestDimensions(unittest.TestCase):
    def _inp(self, result, **kw):
        run = _run()
        return EvaluationInput(run=run, objective=run.objective, ctx=_ctx(run), iteration_id="iter1", result=result, **kw)

    def test_all_dimensions_registered(self):
        for name in ("result_quality", "evidence_quality", "source_quality", "relevance", "completeness",
                     "novelty", "knowledge_gain", "objective_progress", "hypothesis", "uncertainty_reduction",
                     "contradiction", "redundancy", "failure_quality", "confidence"):
            self.assertTrue(DIMENSION_REGISTRY.has(name), name)

    def test_knowledge_gain_rewards_creates(self):
        d = DIMENSION_REGISTRY.get("knowledge_gain")
        low = d.evaluate(self._inp(_result(), knowledge_updates=[])).score
        high = d.evaluate(self._inp(_result(), knowledge_updates=[{"op": "create", "id": "a"}, {"op": "create", "id": "b"}, {"op": "verified", "id": "c"}])).score
        self.assertGreater(high, low)

    def test_deterministic(self):
        d = DIMENSION_REGISTRY.get("relevance")
        inp = self._inp(_result(conclusions=["markets endpoint is public"], evidence=[{"kind": "source", "statement": "markets endpoint is public", "source": "https://x"}]))
        self.assertEqual(d.evaluate(inp).score, d.evaluate(inp).score)


class TestPasses(unittest.TestCase):
    def _inp(self, result, prior=None, attempts=None):
        run = _run()
        return EvaluationInput(run=run, objective=run.objective, ctx=_ctx(run), iteration_id="iter2",
                               result=result, prior_evaluations=prior or [], attempts=attempts or [])

    def test_contradiction_on_opposing_polarity(self):
        prior = EM.ResearchEvaluation(id="e0", research_run_id="run1", iteration_id="iter1",
                                      reasoning={"summary": "markets endpoint requires authentication", "conclusions": ["the markets endpoint requires authentication"]})
        result = _result(conclusions=["the markets endpoint does not require authentication"])
        inp = self._inp(result, prior=[prior])
        from agent.research.evaluator import passes as P
        cons = P.detect_contradictions(inp)
        self.assertTrue(any("disagree" in c.rationale for c in cons), [c.rationale for c in cons])

    def test_redundancy_from_attempt_ledger(self):
        from agent.research.candidates import question_key
        q = "Does endpoint X require auth for market data?"
        attempts = [{"question_norm": question_key(q), "candidate_id": "candX", "outcome": "done", "info_gain": 0.4}]
        inp = self._inp(_result(question=q), attempts=attempts)
        from agent.research.evaluator import passes as P
        red = P.detect_redundancy(inp)
        self.assertIn("candX", red)

    def test_redundancy_by_text_overlap(self):
        prior = EM.ResearchEvaluation(id="e0", research_run_id="run1", iteration_id="iter1",
                                      reasoning={"summary": "the markets endpoint is public and needs no authentication header"})
        result = _result(conclusions=["the markets endpoint is public and needs no authentication header"])
        inp = self._inp(result, prior=[prior])
        from agent.research.evaluator import passes as P
        self.assertIn("iter1", P.detect_redundancy(inp))


class TestFailureQuality(unittest.TestCase):
    def test_informative_failure_scores_higher(self):
        run = _run()
        d = DIMENSION_REGISTRY.get("failure_quality")
        informative = EvaluationInput(run=run, objective=run.objective, ctx=_ctx(run),
                                      result=_result(failure_kind=M.FAIL_HYPOTHESIS_REJECTED, uncertainties=["why?"]))
        uninformative = EvaluationInput(run=run, objective=run.objective, ctx=_ctx(run),
                                        result=_result(failure_kind=M.FAIL_INSUFFICIENT_EVIDENCE))
        self.assertGreater(d.evaluate(informative).score, d.evaluate(uninformative).score)

    def test_transient_marked_retryable(self):
        run = _run()
        ev = asyncio.run(ResearchEvaluator().evaluate(
            EvaluationInput(run=run, objective=run.objective, ctx=_ctx(run),
                            result=_result(failure_kind=M.FAIL_TOOL, failure_reason="boom"))
        ))
        self.assertEqual(ev.status, EM.STATUS_FAILED)
        self.assertTrue(any(s.get("name") == EM.SIG_RETRY_TRANSIENT or s.get("name") == EM.SIG_RETRY_STRATEGY_CHANGE for s in ev.signals))


class TestRecommendation(unittest.TestCase):
    def test_stop_on_objective_satisfied(self):
        from agent.research.evaluator.recommend import SignalDrivenRecommender
        rec = SignalDrivenRecommender().recommend(
            inp=EvaluationInput(run=_run(), objective=_run().objective, ctx=_ctx(_run())),
            dimensions={"confidence": 0.9},
            signals=[EM.EvaluationSignal(name=EM.SIG_STOP_SATISFIED, direction="positive", weight=0.9, reason="done")],
            status=EM.STATUS_SUCCESS, contradictions=[], redundant_with=[],
        )
        self.assertEqual(rec.action, M.ACTION_STOP)

    def test_retry_on_transient_failure(self):
        from agent.research.evaluator.recommend import SignalDrivenRecommender
        rec = SignalDrivenRecommender().recommend(
            inp=EvaluationInput(run=_run(), objective=_run().objective, ctx=_ctx(_run())),
            dimensions={},
            signals=[EM.EvaluationSignal(name=EM.SIG_RETRY_TRANSIENT, direction="positive", weight=0.7, reason="transient")],
            status=EM.STATUS_FAILED, contradictions=[], redundant_with=[],
        )
        self.assertEqual(rec.action, M.ACTION_RETRY)

    def test_resolve_conflict_recommends_comparison(self):
        from agent.research.evaluator.recommend import SignalDrivenRecommender
        rec = SignalDrivenRecommender().recommend(
            inp=EvaluationInput(run=_run(), objective=_run().objective, ctx=_ctx(_run())),
            dimensions={},
            signals=[EM.EvaluationSignal(name=EM.SIG_RESOLVE_CONFLICT, direction="positive", weight=0.8)],
            status=EM.STATUS_PARTIAL_SUCCESS, contradictions=[EM.Contradiction(id="c", subject="x")], redundant_with=[],
        )
        self.assertEqual(rec.action, M.ACTION_CONTINUE)
        self.assertEqual(rec.suggested_strategy, "source-comparison")


class TestLlmJudge(unittest.TestCase):
    def test_clamped_adjustments(self):
        async def fn(system, user):
            # a judge trying to blow up a dimension beyond the clamp
            return '{"adjustments": {"evidence_quality": 1.0, "relevance": -0.03}, "notes": ["looks thin"]}'

        judge = CallableJudge(fn)
        run = _run()
        inp = EvaluationInput(run=run, objective=run.objective, ctx=_ctx(run), result=_result())
        res = asyncio.run(judge.judge(inp, {"evidence_quality": 0.5, "relevance": 0.5}))
        adj = apply_adjustments({"evidence_quality": 0.5, "relevance": 0.5}, res)
        # clamped to +0.2 max
        self.assertLessEqual(adj["evidence_quality"], 0.7 + 1e-9)
        self.assertAlmostEqual(adj["relevance"], 0.47, places=4)

    def test_noop_judge_is_default(self):
        run = _run()
        inp = EvaluationInput(run=run, objective=run.objective, ctx=_ctx(run), result=_result())
        res = asyncio.run(NoopJudge().judge(inp, {}))
        self.assertFalse(res.used)


class TestPipelineEndToEnd(unittest.TestCase):
    def test_full_evaluation_shape(self):
        run = _run(objective="Understand how endpoint X authenticates market data", criteria=["auth known"])
        result = _result(
            observations=[{"statement": "GET /v2/markets returned 200 without an auth header", "source": "https://api.x"}],
            evidence=[{"kind": "source", "statement": "the docs state markets is a public endpoint", "source": "https://docs.x"}],
            sources=["https://api.x", "https://docs.x"],
            conclusions=["The markets endpoint is public and needs no authentication."],
            uncertainties=[], hypothesis_survived=True,
        )
        inp = EvaluationInput(run=run, objective=run.objective, ctx=_ctx(run), iteration_id="iter1",
                              result=result, knowledge_updates=[{"op": "create", "id": "endpoint-x"}])
        ev = asyncio.run(ResearchEvaluator().evaluate(inp))
        self.assertIn(ev.status, EM.EVAL_STATUSES)
        self.assertTrue(ev.evidence_assessments)
        self.assertTrue(ev.signals)
        self.assertTrue(ev.recommendation.get("action"))
        self.assertIn("evidence_quality", ev.scored_by)
        # summary is camelCase and complete
        s = ev.summary()
        self.assertEqual(s["researchRunId"], "run1")
        self.assertIn("dimensions", s)
        self.assertIn("recommendation", s)


class TestLoopIntegration(unittest.TestCase):
    """The evaluator runs as part of the real loop and its output persists."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="eval-test-"))
        vault = self.tmp / "vault"
        (vault / "03-Areas/concepts").mkdir(parents=True)
        (vault / "02-Projects").mkdir(parents=True)
        real = Path(os.environ.get("KM_DEMO_SOURCE", "/home/hermes/vault"))
        for slug in ("mev", "mempool", "oracle"):
            src = real / "03-Areas/concepts" / f"{slug}.md"
            if src.exists():
                shutil.copy2(src, vault / "03-Areas/concepts" / f"{slug}.md")
        if not (vault / "03-Areas/concepts/mev.md").exists():
            (vault / "03-Areas/concepts/mev.md").write_text("---\nconcept: mev\n---\n\n## What\nMEV.\n")
        os.environ["VAULT_ROOT"] = str(vault)
        os.environ["AGENT_DATA_DIR"] = str(self.tmp / "data")
        from agent.knowledge import index as kix
        from agent.tools import vault_index

        kix.invalidate()
        vault_index.invalidate()

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_loop_persists_evaluations(self):
        async def go():
            from agent.knowledge.manager import KnowledgeManager
            from agent.research.config import ResearchConfig
            from agent.research.executor import ScriptedExecutor
            from agent.research.loop import ResearchLoop, build_default_deps
            from agent.research.store import ResearchStore

            def finder(plan, ctx):
                return M.ResearchResult(id=M.new_id("res_"), candidate_id=plan.candidate_id, iteration_id="",
                                        strategy=plan.strategy,
                                        observations=[{"statement": f"observed {plan.question[:30]}", "source": "spec"}],
                                        evidence=[{"kind": "source", "statement": "documented", "source": "https://ethereum.org"}],
                                        sources=["https://ethereum.org"], conclusions=["as documented"], hypothesis_survived=True)

            store = await ResearchStore.open()
            try:
                loop = ResearchLoop(build_default_deps(store=store, km=KnowledgeManager(),
                                                       executor=ScriptedExecutor(rules=[("any", finder)]),
                                                       config=ResearchConfig(max_iterations=2)))
                run = await loop.start({"objective": "Understand MEV extraction preconditions", "success_criteria": ["mev understood"]})
                await loop.advance(run.id)
                run = await store.get_run(run.id)
                evals = await store.list_evaluations(run.id)
                self.assertGreaterEqual(len(evals), 1, "the loop must persist evaluations")
                for e in evals:
                    self.assertIn(e["status"], EM.EVAL_STATUSES)
                    self.assertIn("action", e["recommendation"])
                    self.assertTrue(e["scored_by"])
                # the recommendation was threaded into the iteration record
                its = await store.list_iterations(run.id)
                self.assertTrue(any(it.evaluation.get("research") for it in its))
            finally:
                await store.close()

        asyncio.run(go())


if __name__ == "__main__":
    unittest.main(verbosity=2)
