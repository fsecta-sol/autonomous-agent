"use client";

import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useWorkspace } from "@/components/providers/workspace";
import {
  streamAgentChat,
  describeLlmError,
  type ChatTurn,
  listChats,
  createChat,
  getChat,
  getChatState,
  appendChatMessage,
  deleteChat,
  deleteChats,
  rewindChat,
  updateChat,
  fetchModels,
  fetchSpawns,
  attachRun,
  stopRun,
  getAgentConfig,
  type ChatSession,
  type ChatSessionMessage,
} from "@/lib/api";
import { LlmError } from "@/lib/llm-client";
import type { StreamHandlers } from "@/lib/llm-stream";
import {
  applyMode,
  applyPermission,
  applyReasoning,
  applyText,
  applyToolEnd,
  applyToolStart,
  applyTurnEnd,
  applyTurnError,
  formatDuration,
  initTrace,
  replayTrace,
  reasoningFromEvents,
  syncSpawns,
  type ActivityBranch,
  type ActivityStep,
  type RunEvent,
} from "@/lib/execution";
import { AgentExecutionTimeline, type TraceState } from "@/components/execution/AgentExecutionTimeline";
import { AgentTelemetryStrip, stateLabel, type TelemetryCell } from "@/components/execution/AgentTelemetryStrip";
import { ApprovalCard, type ApprovalState } from "@/components/execution/ApprovalCard";
import { ExecutionOutcome } from "@/components/execution/ExecutionOutcome";
import { renderMarkdown } from "@/lib/markdown";
import { useTelemetry } from "@/lib/useTelemetry";
import { useMediaQuery } from "@/lib/client-store";
import { formatAge, formatLatency, formatRate, formatUptime } from "@/lib/telemetry-format";
import { AgentHeader } from "./console/AgentHeader";
import { ConsoleRail, type ActivityRow, type RailTab, type SubAgentRow, type TaskRow } from "./console/ConsoleRail";
import { AgentConfigPane } from "./AgentConfigPane";
import {
  IconAttachment,
  IconArrowUp,
  IconCheck,
  IconChat,
  IconClose,
  IconCopy,
  IconDoc,
  IconEdit,
  IconGraph,
  IconMic,
  IconRefresh,
  IconScreen,
  IconSearch,
  IconSpark,
  IconStop,
  IconUser,
} from "@/components/ui/icons";
import { Modal } from "@/components/ui/Modal";
import { AgentActivityIndicator } from "@/components/ui/AgentActivityIndicator";
import type { Agent, ChatMessage, PermissionMode, TelemetryState } from "@dashboard/shared";

/** The agent's explicit lifecycle for the active turn. The UI is driven by this,
 *  never inferred from whether a response string happens to be empty. */
type AgentStatus = "idle" | "thinking" | "researching" | "reasoning" | "generating" | "complete" | "error";
interface AgentPhase {
  status: AgentStatus;
  /** number of tool calls seen so far this turn (drives "researching") */
  tools: number;
}

/**
 * The agent console — the product's control surface. A three-zone workspace:
 * the swarm rail on the left (global nav), the conversation at center, and this
 * agent's operational console (swarm, tasks, activity, growth, history, config)
 * on the right. Rendered with `key={agent.id}` so switching agents remounts it.
 *
 * The streaming, telemetry, reasoning and persistence logic below is the
 * product's engine and is unchanged; this rewrite restructures the surface it
 * drives into a dense execution workspace rather than a chat column.
 */
export function AgentDetail({ agent, onBack }: { agent: Agent; onBack: () => void }) {
  const { focusNodeByTitle } = useWorkspace();
  /** the live telemetry feed for the swarm (polled, pauses when hidden) */
  const telemetry = useTelemetry();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  /** the session pending delete confirmation, if any */
  const [deletingSession, setDeletingSession] = useState<ChatSession | null>(null);
  /** multi-select over the history panel: which chats are ticked for bulk delete */
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  /** true while a bulk delete is in flight — locks the selection controls */
  const [bulkDeleting, setBulkDeleting] = useState(false);
  /** a compact failure line under the history header, or null */
  const [bulkError, setBulkError] = useState<string | null>(null);
  /** the bulk delete awaiting one confirmation */
  const [bulkConfirm, setBulkConfirm] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  /** true when the loaded transcript ends on an unanswered user turn: the run
   *  is still going server-side (the view was left mid-turn), so we keep
   *  reading the transcript until its reply lands rather than showing a
   *  conversation that looks truncated. */
  const [awaitingReply, setAwaitingReply] = useState(false);
  /** explicit agent lifecycle — drives the activity indicator and reveal */
  const [phase, setPhase] = useState<AgentPhase>({ status: "idle", tools: 0 });
  const [error, setError] = useState<string | null>(null);
  const [chips, setChips] = useState<Record<string, boolean>>({ reasoning: false, research: false });
  const [attachment, setAttachment] = useState<AttachedFile | null>(null);
  const [micOn, setMicOn] = useState(false);
  /** the live execution trace for the active turn (event-folded, not mocked) */
  const [trace, setTrace] = useState<ActivityStep[]>([]);
  const [traceState, setTraceState] = useState<TraceState>("done");
  const [warnings, setWarnings] = useState<string[]>([]);
  /** the user turn being edited in place, if any (its seq anchors the rewind) */
  const [editing, setEditing] = useState<{ seq: number; text: string } | null>(null);
  /** a model picked before the first session exists; the session's own model
   *  takes over once it does (see the derived `model` below) */
  const [modelDraft, setModelDraft] = useState("");
  /** models the endpoint serves, for the picker (empty = none listed) */
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  /** the model the server would use when none is chosen */
  const [modelDefault, setModelDefault] = useState("");
  /** whether this agent has any callable tool; null = not yet known / unknown */
  const [agentCapable, setAgentCapable] = useState<boolean | null>(null);
  /** the agent's default tool-execution policy, for the header picker's "default" tag */
  const [permissionDefault, setPermissionDefault] = useState<PermissionMode>("ask");
  /** the run's live approval checkpoint, if it is paused on a tool interrupt */
  const [approval, setApproval] = useState<ApprovalState | null>(null);
  /** the checkpoint is unresolved while waiting, submitting, or failed — these
   *  block a new turn and keep the header out of "idle"; approved/rejected are
   *  a settled record the next turn clears. */
  const approvalPending =
    approval != null && approval.phase !== "approved" && approval.phase !== "rejected";
  /** which rail panel is showing (console / history / config) */
  const [railTab, setRailTab] = useState<RailTab>("telemetry");
  /** the rail is a persistent column on desktop, a drawer below the breakpoint.
   *  null = follow the viewport; a boolean = the operator's explicit choice. */
  const [railPref, setRailPref] = useState<boolean | null>(null);
  const isNarrow = useMediaQuery("(max-width: 1100px)");
  const railOpen = railPref ?? !isNarrow;
  const messagesRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  /** true while the reader is parked at (near) the bottom. Only then do we
   *  follow new content; once they scroll up to read, we leave them there
   *  instead of yanking the view back down on every streamed frame. */
  const atBottomRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  /** wall-clock tick so live readings (heartbeat ago, elapsed latency) advance */
  const [nowTick, setNowTick] = useState(() => Date.now());
  /** the active turn's request start + first-token time — measured latency.
   *  Mirrored into state so render can read them (refs are handler-only). */
  const turnStartRef = useRef<number | null>(null);
  const firstTokenRef = useRef<number | null>(null);
  const [turnStartAt, setTurnStartAt] = useState<number | null>(null);
  const [firstTokenAt, setFirstTokenAt] = useState<number | null>(null);
  /** the last settled turn's measured latency, shown until telemetry catches up */
  const [lastTurnLatency, setLastTurnLatency] = useState<{ ttft: number | null; total: number } | null>(null);
  /** set during a stream when a run pauses for approval; read in `finally` */
  const pausedRef = useRef(false);
  /** true while an attach to a possibly-in-flight run is being attempted. Blocks
   *  a concurrent send (the backend would 409 it anyway) without setting the
   *  `sending`/WORKING state that a no-op attach to a settled chat must not show. */
  const attachingRef = useRef(false);
  /** set synchronously the instant a resume is dispatched, so an Approve click
   *  and an ASK→BYPASS switch firing in the same tick can't both POST a resume
   *  (the backend's claim guard is the real guarantee; this avoids the loser
   *  rendering a spurious error card) */
  const resumingRef = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const speechRef = useRef<SpeechRecognition | null>(null);
  const baseInputRef = useRef("");
  /** true from the moment a turn is sent until its stream settles — blocks the
   *  async session loader from overwriting the turn it is filling */
  const streamActiveRef = useRef(false);
  /** typewriter reveal: reasoning and answer deltas queue here and are shown a
   *  few characters per frame, in stream order, so both unfold gradually */
  const revealQueueRef = useRef<{ kind: "reasoning" | "text"; chars: string }[]>([]);
  const revealFrameRef = useRef<number | null>(null);
  /** queued (not-yet-revealed) char counts per kind — keeps a section's header
   *  accurate while its text is still typing out, after the stream has moved on */
  const reasonFlagsRef = useRef({ reasoning: 0, text: 0 });
  /** true while the provider stream is open; false once it ends, so the reveal
   *  pump knows to finalize the turn when it catches up */
  const turnStreamingRef = useRef(false);
  /** fired once the reveal queue is empty after the stream ends */
  const onRevealDoneRef = useRef<(() => void) | null>(null);
  /** latest attach-to-run callback, so an effect can call it without re-running
   *  on every render (its identity is fresh each render) */
  const attachToRunRef = useRef<(sid: string) => Promise<boolean>>(async () => false);

  // Follow new content only while the reader is parked at the bottom. The
  // reveal pump replaces `messages` every animation frame, so an unconditional
  // `scrollTop = scrollHeight` here yanked the view back down each frame —
  // which also swallowed the entrance of any step mounting that same frame.
  useEffect(() => {
    const el = messagesRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, sending, trace]);

  // Live readings tick on their own: 1s at rest is enough for "2.4s ago"; while a
  // turn is streaming we tick faster so the elapsed latency counts up smoothly.
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), sending ? 200 : 1000);
    return () => clearInterval(id);
  }, [sending]);

  /** Keep `atBottomRef` honest as the reader scrolls (or content grows). */
  const onMessagesScroll = () => {
    const el = messagesRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  // Grow the composer with its content, up to the CSS ceiling (past which it
  // scrolls). Reset to `auto` first so deleting text shrinks it back.
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  }, [input]);

  /** Re-surface an approval if the loaded session's run was paused (e.g. after
   *  a reload). Best-effort: a failure just means no pending approval shown. */
  const syncApproval = useCallback(async (sid: string) => {
    try {
      const state = await getChatState(sid);
      if (state.paused && state.interrupt) {
        setApproval({
          interrupt: {
            type: "interrupt",
            id: state.interrupt.id,
            tool: state.interrupt.tool,
            args: state.interrupt.args,
            message: state.interrupt.message,
            // The mode the paused run was asked under, from the checkpoint —
            // historical, never the session's current mode.
            mode: state.interrupt.mode,
          },
          phase: "waiting",
        });
      }
    } catch {
      /* not paused / agent unreachable — nothing to surface */
    }
  }, []);

  // Load the newest session for this agent, or start one if none exist.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await listChats(agent.id);
        // A turn sent before this resolved owns the message list now; don't
        // overwrite the bubble the stream is filling.
        if (cancelled || streamActiveRef.current) return;
        if (list.length) {
          const detail = await getChat(list[0].id);
          if (cancelled || streamActiveRef.current) return;
          setSessions(list);
          setSessionId(detail.id);
          setMessages(detail.messages.map(toUiMessage));
          setAwaitingReply(endsUnanswered(detail.messages));
          void syncApproval(detail.id);
        } else {
          const detail = await createChat(agent.id);
          if (cancelled || streamActiveRef.current) return;
          setSessions([detail]);
          setSessionId(detail.id);
          setMessages([]);
        }
      } catch {
        if (!cancelled) setError("Could not load chat history.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agent.id, syncApproval]);

  // List the models this agent's endpoint serves, for the header picker. A
  // failure leaves the picker with just the server default (never blocks chat).
  useEffect(() => {
    let cancelled = false;
    void fetchModels(agent.id).then((r) => {
      if (cancelled) return;
      setModelOptions(r.models);
      setModelDefault(r.default);
    });
    return () => {
      cancelled = true;
    };
  }, [agent.id]);

  // Whether this agent has any tool it could call — the fact that lets a settled
  // reply say honestly "no tools were invoked" rather than nothing at all. A
  // failed lookup reads as "unknown" (null) and suppresses the notice, so we
  // never claim an agent is tool-less when we simply could not tell. The same
  // fetch yields the agent's default permission mode, shown in the header picker.
  useEffect(() => {
    let cancelled = false;
    void getAgentConfig(agent.id)
      .then((cfg) => {
        if (cancelled) return;
        const hasTools = (cfg.tools?.length ?? 0) > 0 || cfg.terminalMode !== "off" || (cfg.mcpServers?.length ?? 0) > 0;
        setAgentCapable(hasTools);
        setPermissionDefault(cfg.permissionMode ?? "ask");
      })
      .catch(() => {
        if (!cancelled) setAgentCapable(null);
      });
    return () => {
      cancelled = true;
    };
  }, [agent.id]);

  // The conversation's model is derived, not copied into state: once a session
  // exists, the session's own stored model is the source of truth (and
  // `chooseModel` rewrites it in place); only before the first session exists
  // is a local draft held, so the picker keeps the choice for the first message.
  const sessionModel = sessions.find((s) => s.id === sessionId)?.model ?? "";
  const model = sessionId ? sessionModel : modelDraft;

  /** Set the conversation's model and persist it so a reload keeps the choice. */
  const chooseModel = (next: string) => {
    if (!sessionId) {
      setModelDraft(next);
      return;
    }
    setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, model: next || null } : s)));
    void updateChat(sessionId, { model: next || null }).catch(() => {
      /* best-effort: the picker still reflects the in-memory choice */
    });
  };

  // The session's EFFECTIVE tool-execution policy: its own override when set,
  // else the agent's default. Loaded from the session record (session-scoped, so
  // two sessions of one agent can differ) and mirrored from the agent default
  // until a session exists. It is authoritative: switching to BYPASS while a
  // request is pending resolves that request (see `choosePermission`), and the
  // backend re-resolves it from the stored session on every resume.
  const sessionPermission = sessions.find((s) => s.id === sessionId)?.permissionMode ?? null;
  const permissionMode: PermissionMode = sessionPermission ?? permissionDefault;

  /** Set the session's tool-execution policy and persist it. Switching to
   *  BYPASS while a tool request is pending auto-resolves that request: the
   *  backend re-resolves the mode and resumes the paused run (its replayed tool
   *  node then runs without a gate). This reuses the SAME resume path as an
   *  operator approval — there is one resolution mechanism, not two — and the
   *  backend's claim guard makes it idempotent against a simultaneous Approve. */
  const choosePermission = async (next: PermissionMode) => {
    if (!sessionId) {
      // No session yet: the first turn creates it, and the agent default applies
      // until the operator sets an override. Nothing is pending, so nothing runs.
      setPermissionDefault(next);
      return;
    }
    setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, permissionMode: next } : s)));
    try {
      await updateChat(sessionId, { permissionMode: next });
    } catch {
      /* best-effort: the picker still reflects the in-memory choice */
    }
    // Only an unresolved, currently-displayed request needs resolving, and only a
    // switch INTO bypass resolves it. A resume already in flight (sending) owns
    // the run; leave it be.
    if (next === "bypass" && approval?.phase === "waiting" && !sending) {
      await respond("bypass");
    }
  };

  // The loaded transcript ends on an unanswered user turn. EITHER a run is
  // genuinely still in flight server-side (we left mid-turn or reloaded during
  // one) — attach and render it live — OR the last turn was left with no reply
  // (an aborted/probe session), in which case there is nothing to stream and the
  // "still working" state must be cleared rather than re-entered.
  //
  // `sending` is deliberately NOT a dependency: this effect previously re-ran
  // whenever `attachToRun` toggled `sending`, and because a settled session's
  // `GET /run` yields no events, that self-trigger looped forever — one blank
  // placeholder per cycle. The live UI is now gated on a real event (see
  // `attachToRun`), and the no-run path settles in a single recheck.
  useEffect(() => {
    if (!awaitingReply || !sessionId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const start = async () => {
      if (streamActiveRef.current) return; // a live stream owns the list now
      const attached = await attachToRunRef.current(sessionId);
      if (cancelled || attached) {
        if (attached) setAwaitingReply(false);
        return;
      }
      // No live run was found. Recheck the transcript once — a run that just
      // finished may not have its reply row yet — then settle either way, so a
      // stale dangling turn never leaves the agent reading "working".
      timer = setTimeout(async () => {
        if (cancelled || streamActiveRef.current) return;
        try {
          const detail = await getChat(sessionId);
          if (cancelled || streamActiveRef.current) return;
          setMessages(detail.messages.map(toUiMessage));
        } catch {
          /* transient — settle honestly below */
        }
        if (!cancelled) {
          setAwaitingReply(false);
          void listChats(agent.id).then((s) => !cancelled && setSessions(s)).catch(() => {});
        }
      }, 800);
    };
    timer = setTimeout(start, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [awaitingReply, sessionId, agent.id]);

  // While the turn has delegated work, poll the session's spawn log so the
  // delegation branches carry real sub-agent timing as each one finishes.
  const hasDelegate = trace.some((s) => s.kind === "delegate");
  useEffect(() => {
    if (traceState !== "running" || !hasDelegate || !sessionId) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const spawns = await fetchSpawns(sessionId);
        if (!cancelled && spawns.length) setTrace((prev) => syncSpawns(prev, spawns));
      } catch {
        /* spawns are best-effort */
      }
    };
    void poll();
    const timer = setInterval(poll, 4000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [traceState, hasDelegate, sessionId]);

  const toggleChip = (k: string) => setChips((prev) => ({ ...prev, [k]: !prev[k] }));

  // Stop means stop: cancel the run on the SERVER (the backend owns it now), not
  // just detach this view. Then abort the local read so the UI settles at once.
  const stop = () => {
    if (sessionId) void stopRun(sessionId).catch(() => {});
    abortRef.current?.abort();
  };

  const resetReveal = () => {
    if (revealFrameRef.current !== null) {
      cancelAnimationFrame(revealFrameRef.current);
      revealFrameRef.current = null;
    }
    revealQueueRef.current = [];
    reasonFlagsRef.current = { reasoning: 0, text: 0 };
    turnStreamingRef.current = false;
    onRevealDoneRef.current = null;
    // Settle submission state here too, not only in the aborted turn's own
    // `finally`: resetting the view (new chat / switch session) must return the
    // composer to idle at once. When a turn's stream has already closed but its
    // typewriter reveal is still draining, `setSending(false)` lives in the
    // deferred `onRevealDoneRef` callback we are about to null — so clearing
    // that callback alone would leave the composer stuck "working".
    setSending(false);
    setPhase(IDLE_PHASE);
    setTrace([]);
    setTraceState("done");
  };

  const newChat = async () => {
    abortRef.current?.abort(); // end any in-flight turn before clearing the view
    resetReveal();
    setApproval(null);
    try {
      // carry the current model choice into the new conversation
      const detail = await createChat(agent.id, model || undefined);
      setSessionId(detail.id);
      setMessages([]);
      setAwaitingReply(false);
      setError(null);
      setSessions((prev) => [detail, ...prev]);
    } catch {
      setError("Could not start a new chat.");
    }
  };

  const openSession = async (id: string) => {
    if (id === sessionId) return;
    abortRef.current?.abort(); // don't leave a turn streaming into a chat we're leaving
    resetReveal();
    setApproval(null);
    try {
      const detail = await getChat(id);
      setSessionId(detail.id);
      setMessages(detail.messages.map(toUiMessage));
      setAwaitingReply(endsUnanswered(detail.messages));
      setError(null);
      void syncApproval(detail.id);
    } catch {
      setError("Could not open that chat.");
    }
  };

  const removeSession = async (id: string) => {
    try {
      await deleteChat(id);
      const remaining = sessions.filter((s) => s.id !== id);
      setSessions(remaining);
      if (id === sessionId) {
        setApproval(null);
        if (remaining.length) {
          const detail = await getChat(remaining[0].id);
          setSessionId(detail.id);
          setMessages(detail.messages.map(toUiMessage));
          setAwaitingReply(endsUnanswered(detail.messages));
        } else {
          setSessionId(null);
          setMessages([]);
          setAwaitingReply(false);
        }
      }
    } catch {
      setError("Could not delete that chat.");
    }
  };

  /* --- multi-select + bulk delete over the history panel --- */

  const toggleSelecting = useCallback(() => {
    setSelecting((on) => {
      // leaving selection mode always drops the ticks, so a reopened mode starts clean
      if (on) {
        setSelectedIds(new Set());
        setBulkError(null);
      }
      return !on;
    });
  }, []);

  const toggleSession = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /** Drag-paint over the history list: set one row's tick directly (no toggle),
   *  so sweeping up and down selects the range it crosses and never un-does it. */
  const paintSession = useCallback((id: string, on: boolean) => {
    setSelectedIds((prev) => {
      if (on === prev.has(id)) return prev;
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  // Select/deselect every LOADED session. The history list is fully loaded (not
  // paginated), so "all" is exactly the sessions on screen.
  const allSelected = sessions.length > 0 && selectedIds.size === sessions.length;
  const selectAllToggle = useCallback(() => {
    setSelectedIds(allSelected ? new Set() : new Set(sessions.map((s) => s.id)));
  }, [allSelected, sessions]);

  const runBulkDelete = useCallback(async () => {
    if (bulkDeleting) return;
    const ids = [...selectedIds];
    if (!ids.length) return;
    setBulkConfirm(false);
    setBulkDeleting(true);
    setBulkError(null);

    // Snapshot for a clean rollback if the request fails.
    const prevSessions = sessions;
    const prevSessionId = sessionId;
    const prevMessages = messages;
    const prevAwaiting = awaitingReply;
    const deletingActive = sessionId !== null && selectedIds.has(sessionId);

    // Optimistic: drop the ticked rows at once.
    const remaining = sessions.filter((s) => !selectedIds.has(s.id));
    setSessions(remaining);
    if (deletingActive) {
      setApproval(null);
      if (remaining.length) {
        try {
          const detail = await getChat(remaining[0].id);
          setSessionId(detail.id);
          setMessages(detail.messages.map(toUiMessage));
          setAwaitingReply(endsUnanswered(detail.messages));
        } catch {
          /* the switch is best-effort; a failure rolls back below */
        }
      } else {
        setSessionId(null);
        setMessages([]);
        setAwaitingReply(false);
      }
    }

    try {
      await deleteChats(ids);
      setSelectedIds(new Set());
      setSelecting(false);
    } catch {
      // restore exactly what was on screen and keep the ticks so Retry is one click
      setSessions(prevSessions);
      setSessionId(prevSessionId);
      setMessages(prevMessages);
      setAwaitingReply(prevAwaiting);
      setBulkError("Could not delete the selected chats. Try again.");
    } finally {
      setBulkDeleting(false);
    }
  }, [bulkDeleting, selectedIds, sessions, sessionId, messages, awaitingReply]);

  // Escape exits selection mode; Delete/Backspace ask for the one confirmation.
  // Inactive unless selecting, so the composer's own keys are never touched.
  useEffect(() => {
    if (!selecting) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        toggleSelecting();
      } else if ((e.key === "Delete" || e.key === "Backspace") && selectedIds.size > 0 && !bulkDeleting) {
        e.preventDefault();
        setBulkConfirm(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selecting, selectedIds, bulkDeleting, toggleSelecting]);

  /**
   * Queue a streamed chunk and reveal it a few characters per frame, in stream
   * order — so reasoning unfolds first, then the answer, exactly as it arrives.
   */
  const enqueueReveal = (kind: "reasoning" | "text", chars: string) => {
    if (!chars) return;
    revealQueueRef.current.push({ kind, chars });
    reasonFlagsRef.current[kind] += chars.length;
    setPhase((p) => {
      if (p.status === "error") return p;
      if (reasonFlagsRef.current.reasoning > 0) return p.status === "reasoning" ? p : { ...p, status: "reasoning" };
      if (reasonFlagsRef.current.text > 0) return p.status === "generating" ? p : { ...p, status: "generating" };
      return p;
    });
    if (revealFrameRef.current !== null) return;
    revealFrameRef.current = requestAnimationFrame(pumpReveal);
  };

  const pumpReveal = () => {
    const q = revealQueueRef.current;
    if (!q.length) {
      revealFrameRef.current = null;
      if (!turnStreamingRef.current) {
        const done = onRevealDoneRef.current;
        onRevealDoneRef.current = null;
        done?.();
      }
      return;
    }
    // Reveal everything that arrived since the last frame in one block: streamed
    // content lands as it streams, never typed out character by character. The
    // staged mounting of the indicator → reasoning → answer carries the reveal.
    const reason = q.filter((i) => i.kind === "reasoning").map((i) => i.chars).join("");
    const text = q.filter((i) => i.kind === "text").map((i) => i.chars).join("");
    revealQueueRef.current = [];
    reasonFlagsRef.current = { reasoning: 0, text: 0 };
    setMessages((prev) => {
      const copy = prev.slice();
      let last = copy[copy.length - 1];
      if (!last || last.role !== "agent") {
        last = { role: "agent", body: "", stamp: "just now" };
        copy.push(last);
      }
      copy[copy.length - 1] = {
        ...last,
        body: last.body + text,
        reasoning: reason ? (last.reasoning ?? "") + reason : last.reasoning,
      };
      return copy;
    });
    revealFrameRef.current = requestAnimationFrame(pumpReveal);
  };

  /** Immediately show everything still queued (error or hard stop only). */
  const flushReveal = () => {
    if (revealFrameRef.current !== null) {
      cancelAnimationFrame(revealFrameRef.current);
      revealFrameRef.current = null;
    }
    const q = revealQueueRef.current;
    revealQueueRef.current = [];
    reasonFlagsRef.current = { reasoning: 0, text: 0 };
    if (!q.length) return;
    const reason = q.filter((i) => i.kind === "reasoning").map((i) => i.chars).join("");
    const text = q.filter((i) => i.kind === "text").map((i) => i.chars).join("");
    setMessages((prev) => {
      const copy = prev.slice();
      let last = copy[copy.length - 1];
      if (!last || last.role !== "agent") {
        last = { role: "agent", body: "", stamp: "just now" };
        copy.push(last);
      }
      copy[copy.length - 1] = {
        ...last,
        body: last.body + text,
        reasoning: reason ? (last.reasoning ?? "") + reason : last.reasoning,
      };
      return copy;
    });
  };

  /** Record the turn's first token once — the TTFT anchor. */
  const markFirstToken = () => {
    if (firstTokenRef.current !== null) return;
    const t = Date.now();
    firstTokenRef.current = t;
    setFirstTokenAt(t);
  };

  /** The SSE handlers both a fresh send and a re-attach drive. */
  const wireHandlers = (ctrl: AbortController, onSaw?: () => void): StreamHandlers => ({
    signal: ctrl.signal,
    onText: (t) => {
      onSaw?.();
      markFirstToken();
      enqueueReveal("text", t);
      setTrace((prev) => applyText(prev));
    },
    onTool: (e) => {
      onSaw?.();
      setTrace((prev) => (e.phase === "start" ? applyToolStart(prev, e) : applyToolEnd(prev, e)));
      if (e.phase === "start")
        setPhase((p) => (p.status === "reasoning" || p.status === "generating" ? p : { status: "researching", tools: p.tools + 1 }));
    },
    onWarning: (msg) => {
      onSaw?.();
      setWarnings((prev) => (prev.includes(msg) ? prev : [...prev, msg]));
    },
    onPermission: (ev) => {
      onSaw?.();
      // A protected tool's policy decision — bypassed or pending. Folding it in
      // is what lets the timeline show "Permission bypassed" (and never an
      // approval) when the run is in bypass mode.
      setTrace((prev) =>
        applyPermission(prev, { type: "permission", tool: ev.tool, mode: ev.mode, decision: ev.decision, reason: ev.reason }),
      );
    },
    onMode: (ev) => {
      onSaw?.();
      // The session's policy changed mid-run — record it in the trace so the
      // history states the switch happened, distinct from any tool decision.
      setTrace((prev) => applyMode(prev, { type: "mode", from: ev.from, to: ev.to }));
    },
    onReasoning: (t) => {
      onSaw?.();
      markFirstToken();
      enqueueReveal("reasoning", t);
      setTrace((prev) => applyReasoning(prev));
    },
    onInterrupt: (ev) => {
      // A superseded interrupt is recorded history — the pause it describes was
      // already auto-resolved by a mode switch, and the fresh `mode`/`permission`
      // envelopes (and the resumed run) are the live truth. Re-raising its card
      // would be exactly the stale WAITING-under-BYPASS state this fixes.
      if (ev.superseded) return;
      onSaw?.();
      pausedRef.current = true;
      setApproval({ interrupt: ev, phase: "waiting" });
    },
  });

  /** Settle the turn after the stream closes. */
  const finalizeTurn = (sid: string | null) => {
    // Snapshot the instant the provider stream closed: TOTAL latency is the span
    // to the response, NOT to the end of the typewriter reveal. `finish` is
    // deferred until the reveal queue drains, so reading Date.now() there would
    // inflate TOTAL by however long the answer took to type out.
    const settledAt = Date.now();
    turnStreamingRef.current = false;
    const finish = () => {
      setPhase((p) => (p.status === "error" ? p : { status: "complete", tools: p.tools }));
      setSending(false);
      if (turnStartRef.current !== null) {
        const start = turnStartRef.current;
        const first = firstTokenRef.current;
        setLastTurnLatency({
          ttft: first !== null ? Math.max(0, first - start) : null,
          total: Math.max(0, settledAt - start),
        });
      }
      turnStartRef.current = null;
      firstTokenRef.current = null;
      if (pausedRef.current) return;
      setTrace((prev) => applyTurnEnd(prev));
      setTraceState((s) => (s === "error" ? s : "done"));
      if (sid) void graftSeqs(sid);
    };
    onRevealDoneRef.current = finish;
    if (!revealQueueRef.current.length && revealFrameRef.current === null) {
      onRevealDoneRef.current = null;
      finish();
    }
    streamActiveRef.current = false;
    abortRef.current = null;
    if (pausedRef.current) return;
    // A resolved approval checkpoint stays on screen (so a rejection is a durable
    // record, not a vanished prompt); a fresh turn clears it at its own start.
    if (sid) void listChats(agent.id).then((s) => setSessions(s)).catch(() => {});
  };

  /** Shared error handling for a turn's stream (aborted vs. real failure). */
  const handleStreamError = (err: unknown) => {
    const aborted = err instanceof LlmError && err.kind === "aborted";
    if (aborted) {
      flushReveal();
      setTrace((prev) => applyTurnEnd(prev));
      setTraceState("done");
    } else {
      flushReveal();
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        return last && last.role === "agent" && last.body === "" ? prev.slice(0, -1) : prev;
      });
      setPhase({ status: "error", tools: 0 });
      setTrace((prev) => applyTurnError(prev));
      setTraceState("error");
      const notConfigured = err instanceof LlmError && err.status === 501;
      setError(
        notConfigured
          ? "AI not configured — set LLM_API_KEY on the server."
          : describeLlmError(err),
      );
    }
  };

  /** Drive one streamed segment and finalize it. Resolves `true` only when the
   *  stream ran to completion — an abort or a transport failure resolves `false`,
   *  so a caller (an approval resume) can tell a real completion from a request
   *  that never landed, instead of assuming success because this did not throw. */
  const runStream = async (
    turns: ChatTurn[],
    sid: string,
    resume?: { id?: string; decision: "approve" | "deny" | "bypass" },
  ): Promise<boolean> => {
    setSending(true);
    streamActiveRef.current = true;
    turnStreamingRef.current = true;
    reasonFlagsRef.current = { reasoning: 0, text: 0 };
    onRevealDoneRef.current = null;
    pausedRef.current = false;
    if (!resume) {
      const started = Date.now();
      turnStartRef.current = started;
      firstTokenRef.current = null;
      setTurnStartAt(started);
      setFirstTokenAt(null);
      setPhase({ status: "thinking", tools: 0 });
      setTrace(initTrace());
      setTraceState("running");
      setWarnings([]);
    } else {
      setTraceState("running");
    }

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    let ok = true;
    try {
      await streamAgentChat(
        {
          agentId: agent.id,
          sessionId: sid,
          messages: turns,
          resume,
          model: model || undefined,
          reasoning: chips.reasoning,
          research: chips.research,
        },
        wireHandlers(ctrl),
      );
    } catch (err) {
      ok = false;
      handleStreamError(err);
    } finally {
      finalizeTurn(sid);
    }
    return ok;
  };

  /** Re-attach to a run already in flight server-side.
   *
   *  The live UI (the answer bubble, WORKING header, running trace) is entered
   *  ONLY when the first real stream event arrives. Attaching to a settled
   *  session yields nothing but a lone `{type:"done"}`, and opening the live UI
   *  for a run that is not there is exactly the phantom "just now / WORKING"
   *  this must never produce — so the placeholder and the running state wait
   *  for a real event rather than being set up front. Returns whether a run was
   *  actually found. */
  const attachToRun = async (sid: string): Promise<boolean> => {
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    attachingRef.current = true;
    let live = false;
    const beginLive = () => {
      if (live) return;
      live = true;
      setSending(true);
      streamActiveRef.current = true;
      turnStreamingRef.current = true;
      reasonFlagsRef.current = { reasoning: 0, text: 0 };
      onRevealDoneRef.current = null;
      pausedRef.current = false;
      const started = Date.now();
      turnStartRef.current = started;
      firstTokenRef.current = null;
      setTurnStartAt(started);
      setFirstTokenAt(null);
      setPhase({ status: "thinking", tools: 0 });
      setTrace(initTrace());
      setTraceState("running");
      setWarnings([]);
      setMessages((prev) => [...prev, { role: "agent", body: "", stamp: "just now" }]);
    };
    try {
      await attachRun(sid, wireHandlers(ctrl, beginLive));
    } catch (err) {
      if (live) handleStreamError(err);
    } finally {
      attachingRef.current = false;
      if (live) {
        finalizeTurn(sid);
      } else {
        // No run was found — leave the UI exactly as the transcript had it.
        streamActiveRef.current = false;
        abortRef.current = null;
      }
    }
    return live;
  };
  useEffect(() => {
    attachToRunRef.current = attachToRun;
  });

  const send = async () => {
    const text = input.trim();
    if (text.length < 1 || sending || approvalPending || attachingRef.current) return;
    setInput("");
    setError(null);
    setAwaitingReply(false);
    atBottomRef.current = true;
    stopListening();
    setApproval(null); // a fresh turn supersedes any resolved checkpoint

    const sent = buildOutgoing(text, attachment);

    setMessages((prev) => [
      ...prev,
      { role: "you", body: sent, files: attachment ? [attachment.name] : undefined, stamp: "just now" },
      { role: "agent", body: "", stamp: "just now" },
    ]);
    setAttachment(null);

    let sid = sessionId;
    if (!sid) {
      try {
        const detail = await createChat(agent.id);
        sid = detail.id;
        setSessionId(sid);
        setSessions((prev) => [detail, ...prev]);
      } catch {
        setError("Could not start a new chat.");
        return;
      }
    }
    try {
      await appendChatMessage(sid, { role: "user", content: text });
    } catch {
      /* the turn still streams; persistence is best-effort */
    }
    await runStream([{ role: "user", content: sent }], sid);
  };

  /** Answer a paused run's approval request, resuming the same turn. The card
   *  goes SUBMITTING immediately and only resolves when the resumed stream
   *  actually completes — a failed or aborted resume lands on ERROR with a retry,
   *  never a false "approved". If the resumed run pauses again (another tool to
   *  approve), the fresh checkpoint wins and this decision is left alone.
   *
   *  `decision: "bypass"` is the ASK→BYPASS auto-resolve: the backend re-resolves
   *  the session's policy and runs the pending tool without the gate. It is NOT an
   *  operator approval, so the card is cleared (execution takes over) rather than
   *  marked approved — the timeline's own "auto-approved · BYPASS" node records it. */
  const respond = async (decision: "approve" | "deny" | "bypass") => {
    const current = approval;
    // `resumingRef` is set synchronously, so two resumes in the same tick (an
    // Approve click and a mode switch) can't both dispatch — the second sees the
    // ref and no-ops. `sending`/`phase` are React state and can lag a tick.
    if (!current || !sessionId || sending || current.phase === "submitting" || resumingRef.current) return;
    resumingRef.current = true;
    setApproval({ ...current, phase: "submitting", decision });
    pausedRef.current = false;
    let ok = false;
    try {
      ok = await runStream([], sessionId, { id: current.interrupt.id ?? undefined, decision });
    } finally {
      resumingRef.current = false;
    }
    // A new interrupt arrived mid-resume: the freshly-shown checkpoint owns the
    // screen now; do not overwrite it with this turn's resolved state.
    if (pausedRef.current) return;
    if (decision === "bypass") {
      // The switch resolved the request; execution has taken over, so no card
      // remains. On failure keep it, surfacing an actionable retry.
      setApproval((a) => (a ? (ok ? null : { ...a, phase: "error", decision, error: "Could not apply BYPASS — the run did not resume." }) : a));
      return;
    }
    setApproval((a) =>
      a
        ? ok
          ? { ...a, phase: decision === "approve" ? "approved" : "rejected", error: undefined }
          : { ...a, phase: "error", decision, error: "Approval could not be completed — the run did not resume." }
        : a,
    );
  };

  /* --- regenerate / edit-and-resend: rewind the turn's tail, then re-run --- */

  const regenerate = async (agentSeq: number) => {
    if (!sessionId || sending) return;
    const idx = messages.findIndex((m) => m.seq === agentSeq);
    if (idx < 0) return;
    let userIdx = -1;
    for (let i = idx - 1; i >= 0; i--) {
      if (messages[i].role === "you" && typeof messages[i].seq === "number") {
        userIdx = i;
        break;
      }
    }
    if (userIdx < 0) return;
    const userSeq = messages[userIdx].seq!;
    const userContent = messages[userIdx].body;
    if (!userContent) return;
    setMessages((prev) => {
      const i = prev.findIndex((m) => m.seq === userSeq);
      const next = i >= 0 ? prev.slice(0, i + 1) : prev;
      return [...next, { role: "agent", body: "", stamp: "just now" }];
    });
    setError(null);
    try {
      await rewindChat(sessionId, userSeq);
    } catch {
      setError("Could not regenerate — the chat was left as it was.");
      void reloadMessages(sessionId);
      return;
    }
    await runStream([{ role: "user", content: userContent }], sessionId);
  };

  const startEdit = (m: ChatMessage) => {
    if (sending || typeof m.seq !== "number") return;
    setEditing({ seq: m.seq, text: m.body });
  };

  const submitEdit = async () => {
    const edit = editing;
    if (!edit || !sessionId || sending) return;
    const text = edit.text.trim();
    if (!text) return;
    setEditing(null);
    setMessages((prev) => {
      const i = prev.findIndex((m) => m.seq === edit.seq);
      if (i < 0) return prev;
      const next = prev.slice(0, i + 1);
      next[i] = { ...next[i], body: text, files: undefined };
      return [...next, { role: "agent", body: "", stamp: "just now" }];
    });
    setError(null);
    try {
      await rewindChat(sessionId, edit.seq, text);
    } catch {
      setError("Could not resend — the chat was left as it was.");
      void reloadMessages(sessionId);
      return;
    }
    await runStream([{ role: "user", content: text }], sessionId);
  };

  const reloadMessages = async (sid: string) => {
    try {
      const detail = await getChat(sid);
      setMessages(detail.messages.map(toUiMessage));
    } catch {
      /* keep whatever is on screen */
    }
  };

  /** Fill in the `seq` of any settled turn that does not have one yet. */
  const graftSeqs = async (sid: string) => {
    try {
      const detail = await getChat(sid);
      const persisted = detail.messages;
      setMessages((prev) => {
        const offset = persisted.length - prev.length;
        if (offset < 0) return prev;
        return prev.map((m, i) => {
          if (typeof m.seq === "number") return m;
          const p = persisted[offset + i];
          if (!p) return m;
          const roleMatches =
            (p.role === "user" && m.role === "you") ||
            (p.role === "assistant" && m.role === "agent") ||
            (p.role === "system" && m.role === "system");
          return roleMatches ? { ...m, seq: p.seq } : m;
        });
      });
    } catch {
      /* best-effort: the actions appear after the next reload */
    }
  };

  // Row actions are handed to a memoized row, so their identities must be stable.
  // The latest closures live in a ref, refreshed in an effect (not during render).
  const actionsRef = useRef({ regenerate, startEdit, submitEdit });
  useEffect(() => {
    actionsRef.current = { regenerate, startEdit, submitEdit };
  });
  const onRegenerateTurn = useCallback((seq: number) => void actionsRef.current.regenerate(seq), []);
  const onEditTurn = useCallback((m: ChatMessage) => actionsRef.current.startEdit(m), []);
  const onEditSubmitTurn = useCallback(() => void actionsRef.current.submitEdit(), []);
  const onEditChangeTurn = useCallback((v: string) => setEditing((e) => (e ? { ...e, text: v } : e)), []);
  const onEditCancelTurn = useCallback(() => setEditing(null), []);

  /* --- voice input: Web Speech API, feature-detected, no key --- */
  const stopListening = () => {
    try {
      speechRef.current?.stop();
    } catch {
      /* already stopped */
    }
    speechRef.current = null;
    setMicOn(false);
  };

  const toggleMic = () => {
    if (micOn) {
      stopListening();
      return;
    }
    const w = window as unknown as {
      SpeechRecognition?: new () => SpeechRecognition;
      webkitSpeechRecognition?: new () => SpeechRecognition;
    };
    const SR = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!SR) {
      setError("Voice input isn't supported in this browser.");
      return;
    }
    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = document.documentElement.lang || navigator.language || "en-US";
    baseInputRef.current = input ? `${input} ` : "";
    rec.onresult = (e) => setInput(baseInputRef.current + transcriptOf(e));
    rec.onerror = () => stopListening();
    rec.onend = () => {
      speechRef.current = null;
      setMicOn(false);
    };
    speechRef.current = rec;
    setError(null);
    setMicOn(true);
    try {
      rec.start();
    } catch {
      stopListening();
    }
  };

  /* --- attach a note: read a text file into the draft, no server upload --- */
  const onFileChosen = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_ATTACH_BYTES) {
      setError("That file is too large to attach (50 KB max).");
      return;
    }
    try {
      setAttachment({ name: file.name, text: await file.text() });
      setError(null);
    } catch {
      setError("Could not read that file.");
    }
  };

  useEffect(
    () => () => {
      try {
        speechRef.current?.stop();
      } catch {
        /* noop */
      }
    },
    [],
  );

  const activeTitle = sessions.find((s) => s.id === sessionId)?.title ?? "New chat";

  /* --- live telemetry view: real feed ⊕ the active turn's own state --- */
  const feed = telemetry.data?.agents[agent.id] ?? null;
  // A run paused on an approval is still a live run — never idle, never complete,
  // until the checkpoint is resolved. This is the whole point of the header: it
  // must not read "Idle" (or a settled state) while an approval is outstanding.
  const live = sending || awaitingReply || approvalPending;
  const status: TelemetryState = telemetry.offline
    ? "offline"
    : live
      ? "working"
      : feed
        ? feed.state
        : agent.health.beatOk
          ? "idle"
          : "stale";
  const statusDetail = approvalPending
    ? approval!.phase === "submitting"
      ? "Submitting approval…"
      : approval!.phase === "error"
        ? "Approval failed — retry needed"
        : "Waiting for your approval"
    : live
      ? phase.status === "researching"
        ? "Researching sources…"
        : phase.status === "reasoning"
          ? "Reasoning through the evidence…"
          : phase.status === "generating"
            ? "Composing the answer…"
            : "Understanding the request…"
      : status === "stale"
        ? "No recent signal"
        : status === "offline"
          ? "Telemetry feed unreachable"
          : null;

  const heartbeatMs = live
    ? nowTick - (turnStartAt ?? nowTick)
    : feed && feed.heartbeatAgeMs !== null
      ? feed.heartbeatAgeMs + (telemetry.seenAt ? nowTick - telemetry.seenAt : 0)
      : null;
  const heartbeatText = heartbeatMs === null ? null : formatAge(heartbeatMs);
  const heartbeatTone: "ok" | "warn" | "muted" = telemetry.offline
    ? "muted"
    : status === "stale"
      ? "warn"
      : heartbeatMs !== null && heartbeatMs <= 45_000
        ? "ok"
        : "muted";

  const turnLive = sending || awaitingReply;
  // A paused approval is not a running turn — it is counted as paused, not
  // running, so the queue reading stays honest while a checkpoint is open.
  const queueRunning = Math.max(feed?.queue.running ?? 0, turnLive ? 1 : 0);
  const queuePaused = Math.max(feed?.queue.paused ?? 0, approvalPending ? 1 : 0);
  const queueText =
    queueRunning > 0
      ? `${queueRunning} running`
      : queuePaused > 0
        ? `${queuePaused} paused`
        : "0 queued";
  const queueTone: "ok" | "warn" | "muted" = queueRunning > 0 ? "ok" : queuePaused > 0 ? "warn" : "muted";

  const liveTotal = live ? nowTick - (turnStartAt ?? nowTick) : null;
  const liveTtft = firstTokenAt !== null && turnStartAt !== null ? firstTokenAt - turnStartAt : null;
  const latencyTotal = liveTotal ?? lastTurnLatency?.total ?? feed?.latency.total ?? null;
  const latencyTtft = liveTtft ?? lastTurnLatency?.ttft ?? feed?.latency.ttft ?? null;
  const latencyP95 = feed?.latency.p95 ?? null;
  const latencyText = formatLatency(latencyTotal);
  const latencyParts = [latencyTtft !== null ? `ttft ${formatLatency(latencyTtft)}` : null, latencyP95 !== null ? `p95 ${formatLatency(latencyP95)}` : null].filter(
    (x): x is string => x !== null,
  );
  const latencySub = latencyParts.length ? latencyParts.join(" · ") : undefined;

  const cells: TelemetryCell[] = [
    { k: "Heartbeat", v: live ? `live · ${formatAge(heartbeatMs)}` : formatAge(heartbeatMs), tone: heartbeatTone },
    { k: "Status", v: stateLabel(status), tone: status === "offline" ? "muted" : status === "stale" ? "warn" : status === "idle" ? "muted" : "ok" },
    { k: "Uptime", v: telemetry.data ? formatUptime(telemetry.data.uptimeMs) : agent.health.uptime, tone: telemetry.data ? "ok" : "muted" },
    { k: "Task queue", v: queueText, tone: queueTone },
    {
      k: "Error rate",
      v: feed ? formatRate(feed.errorRate) : agent.health.errRate,
      tone: !feed ? (agent.health.errRate === "—" ? "muted" : agent.health.errWarn ? "warn" : "ok") : feed.errorRate === null ? "muted" : feed.errorRate > 0.05 ? "warn" : "ok",
      sub: feed && feed.errorRate === null ? "no history" : undefined,
    },
    {
      k: "Throughput",
      v: feed ? (feed.hasHistory ? `${Math.round(feed.throughputPerHour)}/hr` : "—") : agent.health.throughput,
      tone: feed && feed.hasHistory ? "ok" : "muted",
      sub: feed && !feed.hasHistory ? "no history" : undefined,
    },
    {
      k: "Latency",
      v: latencyText,
      tone: latencyTotal !== null ? "ok" : "muted",
      // show the sub-reading when there is one; when there is none, say WHY
      // (no completed run to measure) rather than leaving a bare "—"
      sub: latencySub ?? (latencyTotal === null && feed && !feed.hasHistory ? "no completed runs" : undefined),
    },
  ];

  const liveReasonStats = trace.length ? statsFromTrace(trace) : "";

  /* --- the rail's task list: only what is actually in flight or configured --- */
  const currentStep = [...trace].reverse().find((s) => s.status === "running" && s.kind !== "thinking");
  const tasks: TaskRow[] = [];
  // While paused on an approval, the run is not "working" — the approval row
  // below is the real state. Only an actively streaming turn shows as running.
  if (live && !approvalPending) {
    tasks.push({
      id: "turn",
      label: currentStep?.title ?? (phase.status === "generating" ? "Composing the answer" : "Understanding the request"),
      state: "running",
      detail: currentStep?.tool ?? undefined,
    });
  }
  if (approvalPending) {
    const t = approval!.interrupt.tool ?? "tool";
    tasks.push({
      id: "approval",
      label: approval!.phase === "submitting" ? `Approving ${t}…` : approval!.phase === "error" ? `${t} — approval failed` : `Run ${t}?`,
      state: "paused",
      detail: approval!.phase === "submitting" ? "submitting decision" : approval!.phase === "error" ? "retry needed" : "awaiting your approval",
    });
  }
  if (queueRunning > (turnLive ? 1 : 0)) {
    const more = queueRunning - (turnLive ? 1 : 0);
    tasks.push({ id: "queue", label: `${more} more run${more === 1 ? "" : "s"} in flight`, state: "running" });
  }
  if (agent.task || agent.currentNode) {
    tasks.push({
      id: "focus",
      label: agent.task || `Working on ${agent.currentNode}`,
      state: "queued",
      detail: agent.currentNode ? `node · ${agent.currentNode}` : undefined,
    });
  }

  const activity = buildActivity(trace, messages);

  return (
    <section className="view active" data-od-id="view-swarm">
      <div className="console" data-od-id="agent-console" data-rail={railOpen ? "open" : "closed"}>
        <div className="console-center">
          <AgentHeader
            agent={agent}
            title={activeTitle}
            status={status}
            statusDetail={statusDetail}
            heartbeatText={heartbeatText}
            onBack={onBack}
            model={model}
            modelOptions={modelOptions}
            modelDefault={modelDefault}
            onChooseModel={chooseModel}
            permissionMode={permissionMode}
            permissionDefault={permissionDefault}
            onChoosePermission={choosePermission}
            sending={sending}
            onNewChat={() => void newChat()}
            onFocusGraph={() => agent.currentNode && focusNodeByTitle(agent.currentNode)}
            sessionId={sessionId}
            railOpen={railOpen}
            onToggleRail={() => setRailPref(!railOpen)}
          />

          <AgentTelemetryStrip cells={cells} />

          <div className="console-chat">
            {warnings.length ? (
              <div className="chat-warnings" role="alert">
                {warnings.map((w, i) => (
                  <div className="chat-warning" key={i}>
                    {w}
                  </div>
                ))}
              </div>
            ) : null}
            {loading ? (
              <div className="chat-empty" data-od-id="chat-loading">
                <span className="sub">Loading conversation…</span>
              </div>
            ) : messages.length === 0 ? (
              <div className="chat-empty" data-od-id="chat-empty">
                <span className="ce-agent" aria-hidden>
                  {agent.name.charAt(0).toUpperCase()}
                </span>
                <span className="ce-name">{agent.name}</span>
                <span className="ce-role">{agent.role || "Agent"}</span>
                <span className="ce-ask">What should I investigate?</span>
                <div className="chat-suggest">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s.label}
                      type="button"
                      className="suggest"
                      onClick={() => {
                        setInput(s.prompt);
                        textareaRef.current?.focus();
                      }}
                    >
                      <span className="suggest-icon">{s.icon}</span>
                      <span className="suggest-label">{s.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="messages" ref={messagesRef} onScroll={onMessagesScroll}>
                {messages.map((m, i) => {
                  const isLast = i === messages.length - 1;
                  const active = trace.length > 0 && phase.status !== "idle" && isLast;
                  const showTraceBefore = active && m.role === "agent";
                  const showTraceAfter = active && m.role === "you" && traceState === "error";
                  const persisted = m.role === "agent" && !active && (m.trace?.length ?? 0) > 0;
                  const canRegen = m.role === "agent" && typeof m.seq === "number";
                  const canEdit = m.role === "you" && typeof m.seq === "number";
                  const isEditing = canEdit && editing !== null && editing.seq === m.seq;
                  // What the execution actually did, stated under the reply so it
                  // can never imply an action that never ran. The live turn's own
                  // trace is the source while it settles; a persisted turn carries
                  // its trace. Only shown once the turn is settled — never mid-stream.
                  const liveTurn = isLast && m.role === "agent" && trace.length > 0 && phase.status !== "idle";
                  const turnSettled = liveTurn ? phase.status === "complete" || phase.status === "error" : true;
                  const outcomeSteps = liveTurn ? trace : m.trace ?? [];
                  const showOutcome = m.role === "agent" && m.body.length > 0 && !isEditing && turnSettled && outcomeSteps.length > 0;
                  return (
                    <Fragment key={i}>
                      {showTraceBefore ? (
                        <AgentExecutionTimeline steps={trace} state={traceState} agentName={agent.name} />
                      ) : persisted ? (
                        <AgentExecutionTimeline steps={m.trace!} state="done" agentName={agent.name} />
                      ) : null}
                      <MessageRow
                        message={m}
                        onCite={focusNodeByTitle}
                        phase={isLast && m.role !== "you" && phase.status !== "idle" ? phase : undefined}
                        suppressIndicator={showTraceBefore}
                        agentName={agent.name}
                        agentRole={agent.role}
                        model={model || modelDefault}
                        busy={sending}
                        canRegenerate={canRegen}
                        editing={isEditing}
                        editText={isEditing ? editing!.text : ""}
                        onEditChange={onEditChangeTurn}
                        onEditSubmit={onEditSubmitTurn}
                        onEditCancel={onEditCancelTurn}
                        onEdit={onEditTurn}
                        onRegenerate={onRegenerateTurn}
                        liveReasonStats={showTraceBefore ? liveReasonStats : undefined}
                      />
                      {showOutcome ? <ExecutionOutcome steps={outcomeSteps} capable={agentCapable === true} /> : null}
                      {showTraceAfter ? (
                        <AgentExecutionTimeline steps={trace} state={traceState} agentName={agent.name} />
                      ) : null}
                    </Fragment>
                  );
                })}
                {awaitingReply && !sending ? (
                  <div className="await-reply" data-od-id="awaiting-reply" role="status" aria-live="polite">
                    <span className="ax-live" aria-hidden />
                    The agent is still working on this — its reply will appear here.
                  </div>
                ) : null}
                {approval ? (
                  <ApprovalCard state={approval} agentName={agent.name} onDecide={(d) => void respond(d)} />
                ) : null}
                {error ? (
                  <div className="message agent">
                    <div className="message-body">
                      {error}{" "}
                      <button className="auth-retry" type="button" onClick={send}>
                        Resend
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            )}
          </div>

          <div className="composer" data-od-id="composer">
            <div className="composer-box">
              <textarea
                ref={textareaRef}
                className="chat-textarea"
                rows={1}
                aria-label="Message this agent"
                placeholder="Message this agent…"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
              />
              {attachment ? (
                <div className="attach-preview">
                  <span className="attach-chip">
                    <IconAttachment />
                    {attachment.name}
                  </span>
                  <button type="button" className="attach-clear" aria-label="Remove attachment" onClick={() => setAttachment(null)}>
                    <IconClose />
                  </button>
                </div>
              ) : null}
              <div className="composer-bar">
                <input
                  ref={fileRef}
                  type="file"
                  accept=".md,.txt,.json,.csv,.log,text/*"
                  hidden
                  onChange={(e) => {
                    void onFileChosen(e.target.files?.[0]);
                    e.target.value = "";
                  }}
                />
                <span className="chips">
                  <button
                    className="chip chip-icon"
                    aria-pressed={!!attachment}
                    aria-label="Attach a note"
                    title="Attach a note"
                    onClick={() => fileRef.current?.click()}
                  >
                    <IconAttachment />
                  </button>
                  <button className="chip" aria-pressed={chips.reasoning} title="Ask the model to reason step by step" onClick={() => toggleChip("reasoning")}>
                    <IconSpark />
                    Reasoning
                  </button>
                  <button className="chip" aria-pressed={chips.research} title="Run a deeper, source-seeking pass first" onClick={() => toggleChip("research")}>
                    <IconScreen />
                    Deep research
                  </button>
                </span>
                {input.trim() ? (
                  <span className="composer-hint" aria-hidden>
                    Enter to send · Shift + Enter for a new line
                  </span>
                ) : null}
                <div className="composer-actions">
                  <button className="mic-btn" aria-pressed={micOn} aria-label="Voice input" onClick={toggleMic}>
                    <IconMic />
                  </button>
                  {sending ? (
                    <button className="send-btn stop-btn" aria-label="Stop generating" onClick={stop}>
                      <IconStop />
                    </button>
                  ) : (
                    <button
                      className={`send-btn ${input.trim() ? "can-send" : ""}`}
                      disabled={!input.trim()}
                      aria-label="Send message"
                      onClick={() => void send()}
                    >
                      <IconArrowUp />
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        {railOpen ? (
          <>
            {isNarrow ? (
              <button type="button" className="rail-veil" aria-label="Hide console panel" onClick={() => setRailPref(false)} />
            ) : null}
            <ConsoleRail
              agent={agent}
              feed={telemetry}
              tasks={tasks}
              subagents={buildSubagents(trace, messages)}
              activity={activity}
              sessions={sessions}
              sessionId={sessionId}
              onOpenSession={(id) => void openSession(id)}
              onDeleteSession={(s) => setDeletingSession(s)}
              selecting={selecting}
              selectedIds={selectedIds}
              allSelected={allSelected}
              deleting={bulkDeleting}
              bulkError={bulkError}
              onToggleSelecting={toggleSelecting}
              onToggleSession={toggleSession}
              onSelectAll={selectAllToggle}
              onBulkDelete={() => setBulkConfirm(true)}
              onPaint={paintSession}
              tab={railTab}
              onTab={setRailTab}
              onFocusGraph={focusNodeByTitle}
              onClose={isNarrow ? () => setRailPref(false) : undefined}
              configSlot={railTab === "config" ? <AgentConfigPane agentId={agent.id} /> : null}
            />
          </>
        ) : null}
      </div>

      {deletingSession ? (
        <Modal labelledBy="del-session-title" onClose={() => setDeletingSession(null)}>
          <h3 id="del-session-title">Delete this chat?</h3>
          <p>
            &ldquo;{deletingSession.title}&rdquo; and its {deletingSession.messageCount} messages will be removed. This
            cannot be undone.
          </p>
          <div className="cfg-modal-actions">
            <button type="button" className="reg-btn" onClick={() => setDeletingSession(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="cfg-danger-btn"
              onClick={() => {
                const id = deletingSession.id;
                setDeletingSession(null);
                void removeSession(id);
              }}
            >
              Delete chat
            </button>
          </div>
        </Modal>
      ) : null}

      {bulkConfirm ? (
        <Modal labelledBy="del-bulk-title" onClose={() => (bulkDeleting ? undefined : setBulkConfirm(false))}>
          <h3 id="del-bulk-title">Delete {selectedIds.size} chats?</h3>
          <p>This will permanently delete the selected chat sessions and all of their messages. This cannot be undone.</p>
          <div className="cfg-modal-actions">
            <button type="button" className="reg-btn" disabled={bulkDeleting} onClick={() => setBulkConfirm(false)}>
              Cancel
            </button>
            <button type="button" className="cfg-danger-btn" disabled={bulkDeleting} onClick={() => void runBulkDelete()}>
              {bulkDeleting ? `Deleting ${selectedIds.size}…` : `Delete ${selectedIds.size}`}
            </button>
          </div>
        </Modal>
      ) : null}
    </section>
  );
}

function toUiMessage(m: ChatSessionMessage): ChatMessage {
  const events = (m.events ?? []) as RunEvent[];
  const trace = m.role === "assistant" && events.length ? replayTrace(events) : undefined;
  const reasoning =
    m.role === "assistant" && events.length ? reasoningFromEvents(events) || undefined : undefined;
  return {
    role: m.role === "user" ? "you" : m.role === "system" ? "system" : "agent",
    body: m.content,
    reasoning,
    trace: trace && trace.length ? trace : undefined,
    links: m.links ?? undefined,
    seq: m.seq,
    stamp: relativeTime(m.createdAt),
  };
}

/** True when the transcript's last real turn is an unanswered user message. */
function endsUnanswered(msgs: ChatSessionMessage[]): boolean {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "user") return true;
    if (msgs[i].role === "assistant") return false;
  }
  return false;
}

/** Compact "4.2s · 8 operations" summary of a turn's settled execution trace. */
function statsFromTrace(steps: ActivityStep[]): string {
  const finished = steps.filter((s) => s.finishedAt);
  if (!finished.length) return "";
  const start = Math.min(...steps.map((s) => s.startedAt));
  const end = Math.max(...finished.map((s) => s.finishedAt!));
  const secs = Math.max(0, end - start) / 1000;
  const dur = secs < 10 ? `${secs.toFixed(1)}s` : `${Math.round(secs)}s`;
  const ops = steps.filter((s) => s.kind !== "thinking").length;
  return `${dur}${ops ? ` · ${ops} operation${ops === 1 ? "" : "s"}` : ""}`;
}

/**
 * Fold the real execution trace (live turn + every persisted turn already on
 * screen) into a newest-first activity feed for the rail. Each line is a step
 * the agent actually took, stamped with its own wall-clock time — never a
 * synthesized event.
 */
function buildActivity(trace: ActivityStep[], messages: ChatMessage[]): ActivityRow[] {
  const out: ActivityRow[] = [];
  const push = (s: ActivityStep) => {
    const at = s.finishedAt ?? s.startedAt;
    if (!at) return;
    out.push({
      id: s.id,
      at,
      agent: s.agent ? s.agent : undefined,
      text: s.title + (s.description && s.kind !== "thinking" ? ` — ${clip(s.description)}` : s.kind === "thinking" ? ` — ${clip(s.description ?? "")}` : ""),
      tone: s.status === "error" ? "err" : s.status === "running" ? "run" : "ok",
    });
  };
  for (const s of trace) push(s);
  for (const m of messages) if (m.role === "agent" && m.trace) for (const s of m.trace) push(s);
  out.sort((a, b) => b.at - a.at);
  return out.slice(0, 14);
}

function clip(s: string, n = 64): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
}

/**
 * Flatten every sub-agent the orchestrator spawned this session — from the live
 * turn's trace and every persisted turn — into one newest-first roster for the
 * rail. Deduped by id so a spawn polled repeatedly is one row, not many.
 */
function buildSubagents(trace: ActivityStep[], messages: ChatMessage[]): SubAgentRow[] {
  const byId = new Map<string, SubAgentRow>();
  const push = (agent: string, b: ActivityBranch) => {
    const at = b.finishedAt ?? b.startedAt ?? 0;
    byId.set(b.id, {
      id: b.id,
      agent: b.agent,
      task: b.label,
      status: b.status,
      at,
      duration: b.status === "running" ? null : formatDuration(b.startedAt ?? 0, b.finishedAt),
    });
    void agent;
  };
  for (const s of trace) if (s.branches) for (const b of s.branches) push(s.agent ?? "", b);
  for (const m of messages) if (m.role === "agent" && m.trace) for (const s of m.trace) if (s.branches) for (const b of s.branches) push(s.agent ?? "", b);
  return [...byId.values()].sort((a, b) => b.at - a.at);
}

function relativeTime(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

/** A file attached to the next message; its text is folded into that turn. */
interface AttachedFile {
  name: string;
  text: string;
}
const MAX_ATTACH_BYTES = 50 * 1024;
const IDLE_PHASE: AgentPhase = { status: "idle", tools: 0 };

/** Starter prompts for the empty conversation — operational, not "how can I help". */
const SUGGESTIONS: { label: string; prompt: string; icon: ReactNode }[] = [
  { label: "Research a topic", prompt: "Research a topic I should look into and report your findings.", icon: <IconSearch /> },
  { label: "Analyze existing knowledge", prompt: "Analyze the existing knowledge graph and surface what matters most right now.", icon: <IconGraph /> },
  { label: "Investigate a source", prompt: "Investigate a source from my inbox and fold what it says into the graph.", icon: <IconDoc /> },
  { label: "Trace relationships", prompt: "Trace the relationships between related concepts and explain how they connect.", icon: <IconChat /> },
];

/** Splice an attached file into the outgoing text as a labeled block. */
function buildOutgoing(text: string, file: AttachedFile | null): string {
  if (!file) return text;
  const block = `Attached file "${file.name}":\n\n${file.text}`;
  return text ? `${text}\n\n${block}` : block;
}

/** The slice of the Web Speech API we use (feature-detected, so not DOM-typed). */
interface SpeechRecognitionResultEvent {
  results: ArrayLike<ArrayLike<{ transcript: string }>>;
}
interface SpeechRecognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  onresult: ((e: SpeechRecognitionResultEvent) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
}
function transcriptOf(e: SpeechRecognitionResultEvent): string {
  let out = "";
  for (let i = 0; i < e.results.length; i++) {
    const alt = e.results[i]?.[0];
    if (alt) out += alt.transcript;
  }
  return out;
}

const STATE_LABEL: Record<AgentStatus, string> = {
  idle: "",
  thinking: "Thinking",
  researching: "Researching",
  reasoning: "Reasoning",
  generating: "Generating",
  complete: "",
  error: "Error",
};

/** True while the stream owns the turn. Used to drive the activity signal. */
function isLivePhase(status: AgentStatus): boolean {
  return status === "thinking" || status === "researching" || status === "reasoning" || status === "generating";
}

/** Memoized so the typewriter reveal does not re-render every earlier row. */
const MessageRow = memo(function MessageRow({
  message,
  onCite,
  phase,
  suppressIndicator,
  agentName,
  agentRole,
  model,
  busy,
  canRegenerate,
  editing,
  editText,
  onEditChange,
  onEditSubmit,
  onEditCancel,
  onEdit,
  onRegenerate,
  liveReasonStats,
}: {
  message: ChatMessage;
  onCite: (t: string) => void;
  phase?: AgentPhase;
  suppressIndicator?: boolean;
  agentName?: string;
  /** the agent's role — the second line of the message metadata */
  agentRole?: string;
  /** the model this conversation runs on — shown beside the role */
  model?: string;
  busy?: boolean;
  canRegenerate?: boolean;
  editing?: boolean;
  editText?: string;
  onEditChange?: (v: string) => void;
  onEditSubmit?: () => void;
  onEditCancel?: () => void;
  onEdit?: (m: ChatMessage) => void;
  onRegenerate?: (seq: number) => void;
  liveReasonStats?: string;
}) {
  const role = message.role === "you" ? "you" : "agent";
  const html = useMemo(
    () =>
      renderMarkdown(message.body, {
        allowRawHtml: false,
        codeCopy: true,
        wiki: (label) => `<button type="button" class="cite" data-cite="${label}">[${label}]</button>`,
      }),
    [message.body],
  );

  const status = phase?.status ?? "idle";
  const reasoningActive = status === "reasoning";
  const live = isLivePhase(status);
  const hasReasoning = (message.reasoning?.length ?? 0) > 0;
  const hasBody = message.body.length > 0;
  // While content is streaming the compact signal sits UNDER the body — the
  // direct replacement for the old inline caret. (The pre-token "agent is
  // working" panel is the execution timeline's job here, so this only covers
  // the streaming-with-text case.)
  const showStreamingSignal = live && hasBody;
  // Keep the wrapper mounted for the whole active turn (phase present, including
  // the settled instant) and drive it by `data-open`, so the grid height
  // collapses on its own when the turn ends — the bubble never snaps.
  const signalWrap = hasBody && phase !== undefined;

  const reasonStats = useMemo(() => {
    if (!hasReasoning) return null;
    if (liveReasonStats) return liveReasonStats;
    const steps = message.trace;
    return steps?.length ? statsFromTrace(steps) : null;
  }, [hasReasoning, liveReasonStats, message.trace]);

  const sources = useMemo(() => {
    if (role !== "agent" || !hasBody) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    const re = /\[\[(.+?)\]\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(message.body))) {
      const label = m[1].trim();
      if (label && !seen.has(label)) {
        seen.add(label);
        out.push(label);
        if (out.length >= 12) break;
      }
    }
    return out;
  }, [role, hasBody, message.body]);

  const [userToggledReason, setUserToggledReason] = useState<boolean | null>(null);
  const reasonOpen = reasoningActive ? true : (userToggledReason ?? false);

  const [copied, setCopied] = useState(false);
  const copyMessage = () => {
    if (!message.body) return;
    void navigator.clipboard?.writeText(message.body).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    });
  };

  const authorLabel = role === "you" ? "You" : message.role === "system" ? "System" : agentName || "Agent";
  const initials =
    role === "you"
      ? ""
      : (agentName || "A")
          .split(/[\s_-]+/)
          .filter(Boolean)
          .slice(0, 2)
          .map((w) => w[0]?.toUpperCase())
          .join("") || "A";

  return (
    <div className={`message ${role}`}>
      <span className={`msg-tile ${role}`} aria-hidden>
        {role === "you" ? <IconUser /> : initials}
      </span>
      <div className="message-col">
        <div className="message-head">
          <span className={`author ${role}`}>{authorLabel}</span>
          {role === "agent" && (agentRole || model) ? (
            <span className="mh-meta">
              {agentRole ? <span className="mh-role">{agentRole}</span> : null}
              {agentRole && model ? <span className="mh-sep" aria-hidden>·</span> : null}
              {model ? <span className="mh-model">{model}</span> : null}
            </span>
          ) : null}
          <span className="mh-tail">
            {phase && !suppressIndicator && STATE_LABEL[status] ? <span className={`agent-state is-${status}`}>{STATE_LABEL[status]}</span> : null}
            {message.stamp ? <span className="timestamp">{message.stamp}</span> : null}
            {!editing && hasBody ? (
              <button
                type="button"
                className="msg-act"
                aria-label="Copy message"
                title={copied ? "Copied" : "Copy message"}
                data-copied={copied || undefined}
                onClick={copyMessage}
              >
                {copied ? <IconCheck /> : <IconCopy />}
              </button>
            ) : null}
            {!editing && role === "you" && onEdit ? (
              <button type="button" className="msg-act" aria-label="Edit message" title="Edit & resend" disabled={busy} onClick={() => onEdit(message)}>
                <IconEdit />
              </button>
            ) : null}
            {!editing && role === "agent" && canRegenerate && onRegenerate ? (
              <button
                type="button"
                className="msg-act"
                aria-label="Regenerate reply"
                title="Regenerate"
                disabled={busy}
                onClick={() => message.seq !== undefined && onRegenerate(message.seq)}
              >
                <IconRefresh />
              </button>
            ) : null}
          </span>
        </div>
        {hasReasoning ? (
          <details
            className={`reasoning ${reasoningActive ? "is-active" : "is-settled"}`}
            open={reasonOpen}
            onToggle={(e) => setUserToggledReason((e.currentTarget as HTMLDetailsElement).open)}
          >
            <summary className="reasoning-sum">
              {reasoningActive ? <span className="reason-spin" aria-hidden /> : <IconCheck />}
              <span className="reasoning-sum-label">{reasoningActive ? "Reasoning" : "Reasoning complete"}</span>
              {reasonStats ? <span className="reasoning-sum-meta">{reasonStats}</span> : null}
            </summary>
            <div className="reasoning-body">{message.reasoning}</div>
          </details>
        ) : null}
        {editing ? (
          <div className="msg-edit">
            <textarea
              className="msg-edit-input"
              autoFocus
              rows={2}
              value={editText}
              aria-label="Edit your message"
              onChange={(e) => onEditChange?.(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  onEditCancel?.();
                } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  onEditSubmit?.();
                }
              }}
            />
            <div className="msg-edit-actions">
              <span className="msg-edit-hint">Ctrl + Enter to resend</span>
              <button type="button" className="reg-btn" onClick={onEditCancel}>
                Cancel
              </button>
              <button type="button" className="approve-btn" disabled={!editText?.trim()} onClick={onEditSubmit}>
                <IconArrowUp />
                Resend
              </button>
            </div>
          </div>
        ) : hasBody ? (
          <>
            <div
              className="message-body md"
              onClick={(e) => {
                const t = e.target as HTMLElement;
                const cite = t.closest(".cite");
                const title = cite?.getAttribute("data-cite");
                if (title) {
                  onCite(title);
                  return;
                }
                const copyBtn = t.closest<HTMLButtonElement>(".md-code-copy");
                if (copyBtn) {
                  const code = copyBtn.closest(".md-code")?.querySelector("code")?.textContent ?? "";
                  void navigator.clipboard?.writeText(code).then(() => {
                    copyBtn.textContent = "Copied";
                    copyBtn.dataset.copied = "true";
                    window.setTimeout(() => {
                      copyBtn.textContent = "Copy";
                      delete copyBtn.dataset.copied;
                    }, 1400);
                  });
                }
              }}
              dangerouslySetInnerHTML={{ __html: html }}
            />
            {signalWrap ? (
              <div className="agent-signal-wrap" data-open={showStreamingSignal ? "" : undefined}>
                <div>
                  <AgentActivityIndicator />
                </div>
              </div>
            ) : null}
          </>
        ) : null}
        {!editing && sources.length ? (
          <div className="msg-sources" data-od-id="message-sources">
            <span className="msg-sources-k">{sources.length} reference{sources.length === 1 ? "" : "s"}</span>
            <div className="msg-sources-list">
              {sources.map((s) => (
                <button key={s} type="button" className="msg-source" title={`Focus "${s}" in the graph`} onClick={() => onCite(s)}>
                  <IconGraph />
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {!editing && message.files?.length ? (
          <div className="message-files">
            {message.files.map((f) => (
              <span className="message-file" key={f}>
                <IconAttachment />
                {f}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
});
