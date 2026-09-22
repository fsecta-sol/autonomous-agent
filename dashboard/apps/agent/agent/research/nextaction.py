"""NextActionSelector — CONTINUE / BRANCH / RETRY / WAIT / STOP (spec §17, §26).

The decision after each iteration, kept as its own module so the loop reads as a
state machine and the policy is replaceable. Deterministic and inspectable: each
branch of the decision records its reason, which the iteration persists and the
UI shows ("why did it choose this research task?").
"""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass

from . import models as M
from .stop import StopDecision

log = logging.getLogger("agent.research.nextaction")


@dataclass
class NextAction:
    action: str            # a models.ACTION_* value
    reason: str = ""
    branch: str = "main"   # when BRANCH: the branch to focus next
    focus: str = ""        # a human hint for the next cycle's context

    def to_dict(self) -> dict:
        return {"action": self.action, "reason": self.reason, "branch": self.branch, "focus": self.focus}


class NextActionSelector(ABC):
    @abstractmethod
    def select(
        self,
        *,
        evaluation: M.Evaluation,
        stop: StopDecision | None,
        run: M.ResearchRun,
        attempts_on_question: int,
        max_attempts: int,
        branch_depth: int,
        max_branch_depth: int,
        waiting: bool = False,
        recommendation: dict | None = None,
    ) -> NextAction:
        ...


class DefaultNextActionSelector(NextActionSelector):
    def select(
        self,
        *,
        evaluation: M.Evaluation,
        stop: StopDecision | None,
        run: M.ResearchRun,
        attempts_on_question: int,
        max_attempts: int,
        branch_depth: int,
        max_branch_depth: int,
        waiting: bool = False,
        recommendation: dict | None = None,
    ) -> NextAction:
        # 1. an explicit stop condition always wins
        if stop is not None:
            return NextAction(M.ACTION_STOP, stop.reason)

        # 2. a run that needs an external decision waits (context preserved)
        if waiting or run.status == M.RUN_WAITING:
            return NextAction(M.ACTION_WAIT, "awaiting operator input")

        # 2b. the Research Evaluator's recommendation, when it drives a valid
        #     action. It is decision-support: the deterministic fallbacks below
        #     still apply when it is absent or maps to CONTINUE without a nudge.
        rec = self._from_recommendation(recommendation, run, attempts_on_question, max_attempts, branch_depth, max_branch_depth)
        if rec is not None:
            return rec

        # 3. failure handling: retry only while under the attempt cap AND only for
        #    transient failures. A rejected hypothesis is not retried — it is a
        #    result (the branch/continue path handles it).
        if evaluation.failed:
            # Honour the analyzer's retry classification (Evaluation.should_retry),
            # falling back to the failure kind for evaluations built without it.
            transient = evaluation.should_retry or evaluation.failure_kind in (
                M.FAIL_TOOL, M.FAIL_SOURCE_UNAVAILABLE, M.FAIL_TIMEOUT)
            if transient and attempts_on_question < max_attempts:
                return NextAction(M.ACTION_RETRY, f"{evaluation.failure_kind}, attempt {attempts_on_question + 1}/{max_attempts}")
            return NextAction(M.ACTION_CONTINUE, f"abandoning after {evaluation.failure_kind}")

        # 4. a discovery that opened a new direction, when there is branch room
        if evaluation.should_branch and branch_depth < max_branch_depth:
            focus = evaluation.notes[0] if evaluation.notes else "new direction"
            return NextAction(M.ACTION_BRANCH, "unexpected finding opened a new direction", branch=focus, focus=focus)

        # 5. default: keep going on the main line
        return NextAction(M.ACTION_CONTINUE, "making progress")

    @staticmethod
    def _from_recommendation(
        rec: dict | None,
        run: M.ResearchRun,
        attempts: int,
        max_attempts: int,
        branch_depth: int,
        max_branch_depth: int,
    ) -> NextAction | None:
        """Translate an evaluator recommendation into a NextAction, or None to
        fall through to the deterministic policy. Respects the loop's own caps:
        a RETRY recommendation cannot exceed max_attempts, and a BRANCH cannot
        exceed max_branch_depth."""
        if not rec:
            return None
        action = rec.get("action", "")
        reason = rec.get("reason", "") or "evaluator recommendation"
        if action == M.ACTION_STOP:
            return NextAction(M.ACTION_STOP, reason)
        if action == M.ACTION_RETRY:
            if attempts >= max_attempts:
                return None  # the loop's cap has the final say
            return NextAction(M.ACTION_RETRY, reason)
        if action == M.ACTION_BRANCH:
            if branch_depth >= max_branch_depth:
                return None
            focus = rec.get("suggested_focus", "") or reason
            return NextAction(M.ACTION_BRANCH, reason, branch=focus, focus=focus)
        if action == M.ACTION_WAIT:
            return NextAction(M.ACTION_WAIT, reason)
        # CONTINUE: only take it when it carries a concrete nudge (a suggested
        # focus), otherwise let the deterministic default run.
        if action == M.ACTION_CONTINUE and rec.get("suggested_strategy"):
            return NextAction(M.ACTION_CONTINUE, reason)
        return None
