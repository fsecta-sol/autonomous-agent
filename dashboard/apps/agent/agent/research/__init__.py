"""The Research Loop — a modular, resumable, extensible research engine.

The Markdown knowledge graph (via the KnowledgeManager) is the persistent
knowledge layer; this package is the *process* that grows it. It is a pipeline of
small modules, not one hardcoded loop:

    context      ContextLoader        — assemble the run's context
    gaps         KnowledgeGapDetector — turn knowledge state into gaps
    candidates   CandidateGenerator/Evaluator — gaps → candidate questions
    prioritizer  ResearchPrioritizer  — pluggable ranking
    planner      ResearchPlanner      — candidate + strategy → plan
    strategies/  ResearchStrategy     — pluggable investigation behaviours
    executor     ResearchExecutor     — delegate execution to the agent runtime
    analyzer     ResultAnalyzer       — evidence → observations/conclusions
    updater      KnowledgeUpdater     — integrate into the KnowledgeManager
    progress     ProgressEvaluator    — information-gain-oriented progress
    stop         StopCondition        — pluggable stopping rules
    nextaction   NextActionSelector   — CONTINUE / BRANCH / RETRY / WAIT / STOP
    loop         ResearchLoop         — the explicit state machine that wires them
    runner       ResearchRunner       — an in-process background driver
    store        ResearchStore        — durable State Manager + Research Memory

Everything is importable without the LangGraph runtime, so the loop is testable
and demonstrable on its own; only the executor reaches into the agent's model.
"""
