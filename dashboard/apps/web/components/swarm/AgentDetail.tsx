"use client";

import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  fetchSpawns,
  type ChatSession,
  type ChatSessionMessage,
} from "@/lib/api";
import { LlmError } from "@/lib/llm-client";
import type { InterruptEvent } from "@/lib/llm-stream";
import {
  applyReasoning,
  applyText,
  applyToolEnd,
  applyToolStart,
  applyTurnEnd,
  applyTurnError,
  initTrace,
  syncSpawns,
  type ActivityStep,
} from "@/lib/execution";
import { AgentExecutionTimeline, type TraceState } from "@/components/execution/AgentExecutionTimeline";
import { renderMarkdown } from "@/lib/markdown";
import { AgentConfigPane } from "./AgentConfigPane";
import { IconAttachment, IconBolt, IconCheck, IconChevronLeft, IconChat, IconClose, IconMic, IconPlus, IconScreen, IconSearch, IconSpark, IconArrowUp, IconTrash } from "@/components/ui/icons";
import { Modal } from "@/components/ui/Modal";
import type { Agent, ChatMessage } from "@dashboard/shared";

type Pane = "conversation" | "history" | "health" | "config";

/** The agent's explicit lifecycle for the active turn. The UI is driven by this,
 *  never inferred from whether a response string happens to be empty. */
type AgentStatus = "idle" | "thinking" | "researching" | "reasoning" | "generating" | "complete" | "error";
interface AgentPhase {
  status: AgentStatus;
  /** number of tool calls seen so far this turn (drives "researching") */
  tools: number;
}

const STATUS_LABEL: Record<string, string> = {
  working: "working",
  analysing: "analysing",
  idle: "idle",
  pending: "pending",
};

/**
 * Rendered with `key={agent.id}` so switching agents remounts the view. On
 * mount it loads the agent's most recent session (or starts a new one); every
 * turn is persisted to SQLite through /api/chats.
 */
export function AgentDetail({ agent, onBack }: { agent: Agent; onBack: () => void }) {
  const { focusNodeByTitle } = useWorkspace();
  const [pane, setPane] = useState<Pane>("conversation");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  /** the session pending delete confirmation, if any */
  const [deletingSession, setDeletingSession] = useState<ChatSession | null>(null);
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
  /** a pending tool-approval the run is paused on, if any */
  const [pendingApproval, setPendingApproval] = useState<InterruptEvent | null>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  /** true while the reader is parked at (near) the bottom. Only then do we
   *  follow new content; once they scroll up to read, we leave them there
   *  instead of yanking the view back down on every streamed frame. */
  const atBottomRef = useRef(true);
  const approvalRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** assistant text accumulated across a whole turn (survives an approval pause
   *  so the persisted reply spans pause + resume) */
  const accRef = useRef("");
  /** set during a stream when a run pauses for approval; read in `finally` */
  const pausedRef = useRef(false);
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

  // Follow new content only while the reader is parked at the bottom. The
  // reveal pump replaces `messages` every animation frame, so an unconditional
  // `scrollTop = scrollHeight` here yanked the view back down each frame —
  // which also swallowed the entrance of any step mounting that same frame.
  useEffect(() => {
    const el = messagesRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, sending, trace]);

  /** Keep `atBottomRef` honest as the reader scrolls (or content grows). */
  const onMessagesScroll = () => {
    const el = messagesRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  // A run pausing for approval must pull the operator's attention: move focus
  // onto the prompt so a keyboard/SR user lands on Deny/Approve, not mid-scroll.
  useEffect(() => {
    if (pendingApproval) approvalRef.current?.focus();
  }, [pendingApproval]);

  /** Re-surface an approval if the loaded session's run was paused (e.g. after
   *  a reload). Best-effort: a failure just means no pending approval shown. */
  const syncPendingApproval = useCallback(async (sid: string) => {
    try {
      const state = await getChatState(sid);
      if (state.paused && state.interrupt) {
        setPendingApproval({
          type: "interrupt",
          id: state.interrupt.id,
          tool: state.interrupt.tool,
          args: state.interrupt.args,
          message: state.interrupt.message,
        });
      }
    } catch {
      /* not paused / agent unreachable — nothing to surface */
    }
  }, []);

  // Load the newest session for this agent, or start one if none exist.
  // `loading` already starts true; the component remounts per agent (key).
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
          void syncPendingApproval(detail.id);
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
  }, [agent.id, syncPendingApproval]);

  // The loaded transcript ends on an unanswered user turn — its run is still
  // finishing server-side (we left the view mid-turn or reloaded during one).
  // Poll the persisted transcript until the reply lands, so returning to the
  // chat shows the answer instead of a conversation that stops at the question.
  useEffect(() => {
    if (!awaitingReply || !sessionId || sending) return;
    let cancelled = false;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (streamActiveRef.current) return; // a live stream owns the list now
      tries += 1;
      try {
        const detail = await getChat(sessionId);
        if (cancelled || streamActiveRef.current) return;
        const filled = !endsUnanswered(detail.messages);
        setMessages(detail.messages.map(toUiMessage));
        if (filled) {
          setAwaitingReply(false);
          void listChats(agent.id).then((s) => !cancelled && setSessions(s)).catch(() => {});
          return;
        }
      } catch {
        /* transient — keep polling */
      }
      // ~2.5 min ceiling: a real run finishes inside it; past that, stop quietly.
      if (tries >= 60) {
        setAwaitingReply(false);
        return;
      }
      timer = setTimeout(poll, 2500);
    };
    timer = setTimeout(poll, 2500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [awaitingReply, sessionId, sending, agent.id]);

  // While the turn has delegated work, poll the session's spawn log so the
  // delegation branches carry real sub-agent timing as each one finishes. The
  // spawns are a view onto the run, never a gate: a failure just leaves the
  // branches as the stream reported them.
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

  // Roving-tabindex tabs need arrow keys to move between them (ARIA Tabs pattern).
  const onTablistKeyDown = (e: React.KeyboardEvent) => {
    const order: Pane[] = ["conversation", "history", "health", "config"];
    const i = order.indexOf(pane);
    let next = -1;
    if (e.key === "ArrowRight") next = (i + 1) % order.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + order.length) % order.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = order.length - 1;
    else return;
    e.preventDefault();
    const target = order[next];
    setPane(target);
    document.getElementById(`tab-${target}`)?.focus();
  };

  const stop = () => abortRef.current?.abort();

  const resetReveal = () => {
    if (revealFrameRef.current !== null) {
      cancelAnimationFrame(revealFrameRef.current);
      revealFrameRef.current = null;
    }
    revealQueueRef.current = [];
    reasonFlagsRef.current = { reasoning: 0, text: 0 };
    turnStreamingRef.current = false;
    onRevealDoneRef.current = null;
    setPhase(IDLE_PHASE);
    setTrace([]);
    setTraceState("done");
  };

  const newChat = async () => {
    abortRef.current?.abort(); // end any in-flight turn before clearing the view
    resetReveal();
    setPendingApproval(null);
    try {
      const detail = await createChat(agent.id);
      setSessionId(detail.id);
      setMessages([]);
      setAwaitingReply(false);
      setError(null);
      setPane("conversation");
      setSessions((prev) => [detail, ...prev]);
    } catch {
      setError("Could not start a new chat.");
    }
  };

  const openSession = async (id: string) => {
    if (id === sessionId) {
      setPane("conversation");
      return;
    }
    abortRef.current?.abort(); // don't leave a turn streaming into a chat we're leaving
    resetReveal();
    setPendingApproval(null);
    try {
      const detail = await getChat(id);
      setSessionId(detail.id);
      setMessages(detail.messages.map(toUiMessage));
      setAwaitingReply(endsUnanswered(detail.messages));
      setError(null);
      setPane("conversation");
      void syncPendingApproval(detail.id);
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
        setPendingApproval(null);
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

  /**
   * Queue a streamed chunk and reveal it a few characters per frame, in stream
   * order — so reasoning unfolds first, then the answer, exactly as it arrives.
   * A queued chunk keeps its section "active" until it is fully revealed, so the
   * header/timing reflect what is on screen, not what has been received.
   */
  const enqueueReveal = (kind: "reasoning" | "text", chars: string) => {
    if (!chars) return;
    revealQueueRef.current.push({ kind, chars });
    reasonFlagsRef.current[kind] += chars.length;
    // header follows what is showing: the newest *visible* kind wins, unless a
    // reasoning backlog is still unspent (reasoning should finish first)
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
      // stream already ended and the queue is drained — the turn is complete
      if (!turnStreamingRef.current) {
        const done = onRevealDoneRef.current;
        onRevealDoneRef.current = null;
        done?.();
      }
      return;
    }
    const head = q[0];
    // steady typing pace; speed up only past a large backlog, and cap it — a
    // big chunk from the provider must still unfold gradually, not pop in
    let backlog = 0;
    for (const item of q) backlog += item.chars.length;
    const extra = backlog > REVEAL_BACKLOG_SOFT ? Math.floor((backlog - REVEAL_BACKLOG_SOFT) / REVEAL_CATCHUP_DIVISOR) : 0;
    const take = Math.min(head.chars.length, Math.min(REVEAL_MAX_PER_FRAME, REVEAL_BASE_PER_FRAME + extra));
    const piece = head.chars.slice(0, take);
    head.chars = head.chars.slice(take);
    reasonFlagsRef.current[head.kind] -= take;
    if (!head.chars.length) q.shift();
    setMessages((prev) => {
      const copy = prev.slice();
      const last = copy[copy.length - 1];
      if (!last || last.role !== "agent") {
        copy.push({
          role: "agent",
          body: head.kind === "text" ? piece : "",
          reasoning: head.kind === "reasoning" ? piece : undefined,
          stamp: "just now",
        });
      } else if (head.kind === "reasoning") {
        copy[copy.length - 1] = { ...last, reasoning: (last.reasoning ?? "") + piece };
      } else {
        copy[copy.length - 1] = { ...last, body: last.body + piece };
      }
      return copy;
    });
    revealFrameRef.current = requestAnimationFrame(pumpReveal);
  };

  /**
   * Immediately show everything still queued. Used only when the reveal must not
   * continue — an error or a hard stop — never on a normal finish, where the
   * queue should keep animating.
   */
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

  /**
   * Drive one streamed segment and finalize it. `turns` seeds the model; `resume`
   * answers a paused approval instead. Assistant text accumulates in `accRef`
   * across a pause/resume so the whole turn persists as one message.
   */
  const runStream = async (turns: ChatTurn[], sid: string, resume?: { id?: string; decision: "approve" | "deny" }) => {
    setSending(true);
    streamActiveRef.current = true;
    turnStreamingRef.current = true;
    reasonFlagsRef.current = { reasoning: 0, text: 0 };
    onRevealDoneRef.current = null;
    pausedRef.current = false;
    if (!resume) {
      setPhase({ status: "thinking", tools: 0 });
      setTrace(initTrace());
      setTraceState("running");
      setWarnings([]);
      accRef.current = "";
    } else {
      setTraceState("running");
    }

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      await streamAgentChat(
        {
          agentId: agent.id,
          sessionId: sid,
          messages: turns,
          resume,
          reasoning: chips.reasoning,
          research: chips.research,
        },
        {
          signal: ctrl.signal,
          onText: (t) => {
            accRef.current += t;
            enqueueReveal("text", t);
            setTrace((prev) => applyText(prev));
          },
          onTool: (e) => {
            setTrace((prev) => (e.phase === "start" ? applyToolStart(prev, e) : applyToolEnd(prev, e)));
            if (e.phase === "start") setPhase((p) => (p.status === "reasoning" || p.status === "generating" ? p : { status: "researching", tools: p.tools + 1 }));
          },
          onWarning: (msg) => setWarnings((prev) => (prev.includes(msg) ? prev : [...prev, msg])),
          onReasoning: (t) => {
            enqueueReveal("reasoning", t);
            setTrace((prev) => applyReasoning(prev));
          },
          onInterrupt: (ev) => {
            // the run paused for approval — surface it and keep the turn open
            pausedRef.current = true;
            setPendingApproval(ev);
          },
        },
      );
    } catch (err) {
      const aborted = err instanceof LlmError && err.kind === "aborted";
      if (aborted) {
        // stop means stop — show what streamed at once rather than finishing the animation
        flushReveal();
        setTrace((prev) => applyTurnEnd(prev));
        setTraceState("done");
      } else {
        // flush any partial text, then drop the empty agent bubble so the error
        // reads as its own row instead of a blank one
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
    } finally {
      // the stream is closed; the reveal queue keeps typing out on its own, and
      // finalizes the turn only once it drains (see pumpReveal)
      turnStreamingRef.current = false;
      const finish = () => {
        setPhase((p) => (p.status === "error" ? p : { status: "complete", tools: p.tools }));
        setSending(false);
        // A run paused for approval is not finished — leave the trace open so
        // the panel still reads as in-flight behind the approval prompt.
        if (pausedRef.current) return;
        // settle the execution trace: mark every running step done and close it
        setTrace((prev) => applyTurnEnd(prev));
        setTraceState((s) => (s === "error" ? s : "done"));
      };
      onRevealDoneRef.current = finish;
      // if nothing is left to reveal, or the pump is idle, finalize right away
      if (!revealQueueRef.current.length && revealFrameRef.current === null) {
        onRevealDoneRef.current = null;
        finish();
      }
      streamActiveRef.current = false;
      abortRef.current = null;
      // A paused run is not finished: keep the accumulated reply and the pending
      // approval so the operator's decision resumes the SAME turn.
      if (pausedRef.current) return;
      // persist whatever assistant text streamed (including a partial on stop)
      if (accRef.current.trim()) {
        try {
          await appendChatMessage(sid, { role: "assistant", content: accRef.current });
          setSessions(await listChats(agent.id));
        } catch {
          /* history save is best-effort; the reply is already on screen */
        }
      }
      accRef.current = "";
      setPendingApproval(null);
    }
  };

  const send = async () => {
    const text = input.trim();
    if (text.length < 1 || sending || pendingApproval) return;
    setInput("");
    setError(null);
    setAwaitingReply(false); // this turn's own stream now owns the transcript
    atBottomRef.current = true; // sending always returns you to your own turn
    stopListening(); // a voice capture ends when the message is sent

    // An attached file is folded into this turn's text (no server upload).
    const sent = buildOutgoing(text, attachment);

    // Append the user turn and an empty agent bubble that the stream fills.
    setMessages((prev) => [
      ...prev,
      { role: "you", body: sent, files: attachment ? [attachment.name] : undefined, stamp: "just now" },
      { role: "agent", body: "", stamp: "just now" },
    ]);
    setAttachment(null);

    // The server reads the transcript from its own store, so only the new turn
    // is sent; a session is created on the fly if this is the first message.
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

  /** Answer a paused run's approval request, resuming the same turn. */
  const respond = async (decision: "approve" | "deny") => {
    const approval = pendingApproval;
    if (!approval || !sessionId || sending) return;
    setPendingApproval(null);
    await runStream([], sessionId, { id: approval.id ?? undefined, decision });
  };

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

  // release the mic if the view unmounts mid-capture
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

  const h = agent.health;
  const beatCell = h.beatOk ? "ok" : "warn";
  const errCell = h.errWarn ? "warn" : "ok";
  const activeTitle = sessions.find((s) => s.id === sessionId)?.title ?? "New chat";

  return (
    <section className="view active" data-od-id="view-swarm">
      <div className="swarm-detail" data-od-id="swarm-detail">
        <div className="rd-topbar">
          <button type="button" className="rd-back" data-od-id="swarm-back" onClick={onBack}>
            <IconChevronLeft />
            All agents
          </button>
          <span className="ad-session-title" data-od-id="session-title" title={activeTitle}>
            {activeTitle}
          </span>
          <button className="newchat-btn" data-od-id="new-chat" onClick={() => void newChat()}>
            <IconPlus />
            New chat
          </button>
        </div>

        <div className="ad-head" data-od-id="agent-head">
          <span className="ad-avatar">{agent.name.charAt(0)}</span>
          <span className="ad-id">
            <span className="ad-name">{agent.name}</span>
            <span className="ad-role">{agent.role}</span>
          </span>
          <span className="fc-status ad-status" data-st={agent.status}>
            {STATUS_LABEL[agent.status] ?? agent.status}
          </span>
          <button
            type="button"
            className="ad-focus"
            data-od-id="agent-focus-graph"
            disabled={!agent.currentNode}
            onClick={() => agent.currentNode && focusNodeByTitle(agent.currentNode)}
          >
            <IconSearch />
            Focus in graph
          </button>
        </div>

        <div className="ad-health" data-od-id="agent-health">
          <div className="ad-hcell">
            <span className="k">Heartbeat</span>
            <span className={`v ${beatCell}`}>{h.heartbeat}</span>
          </div>
          <div className="ad-hcell">
            <span className="k">Uptime</span>
            <span className="v">{h.uptime}</span>
          </div>
          <div className="ad-hcell">
            <span className="k">Task queue</span>
            <span className="v">{h.queue}</span>
          </div>
          <div className="ad-hcell">
            <span className="k">Error rate</span>
            <span className={`v ${errCell}`}>{h.errRate}</span>
          </div>
          <div className="ad-hcell">
            <span className="k">Throughput</span>
            <span className="v">{h.throughput}</span>
          </div>
        </div>

        <div
          className="seg"
          role="tablist"
          aria-label="Agent workspace"
          onKeyDown={onTablistKeyDown}
        >
          <button
            className="seg-btn"
            role="tab"
            id="tab-conversation"
            aria-controls="panel-conversation"
            aria-selected={pane === "conversation"}
            tabIndex={pane === "conversation" ? 0 : -1}
            data-od-id="seg-conversation"
            onClick={() => setPane("conversation")}
          >
            Chat
          </button>
          <button
            className="seg-btn"
            role="tab"
            id="tab-history"
            aria-controls="panel-history"
            aria-selected={pane === "history"}
            tabIndex={pane === "history" ? 0 : -1}
            data-od-id="seg-history"
            onClick={() => setPane("history")}
          >
            History
          </button>
          <button
            className="seg-btn"
            role="tab"
            id="tab-health"
            aria-controls="panel-health"
            aria-selected={pane === "health"}
            tabIndex={pane === "health" ? 0 : -1}
            data-od-id="seg-health"
            onClick={() => setPane("health")}
          >
            Health
          </button>
          <button
            className="seg-btn"
            role="tab"
            id="tab-config"
            aria-controls="panel-config"
            aria-selected={pane === "config"}
            tabIndex={pane === "config" ? 0 : -1}
            data-od-id="seg-config"
            onClick={() => setPane("config")}
          >
            Config
          </button>
        </div>

        <div className="ad-body">
          {pane === "conversation" ? (
            <div className="chat-pane active" role="tabpanel" id="panel-conversation" aria-labelledby="tab-conversation">
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
                  <span className="chat-orb">
                    <svg viewBox="0 0 64 64" fill="none" stroke="currentColor" aria-hidden="true">
                      <circle cx="32" cy="32" r="6" fill="currentColor" stroke="none" />
                      <circle cx="32" cy="32" r="13" strokeWidth="1.5" opacity=".55" />
                      <circle cx="32" cy="32" r="20" strokeWidth="1.2" strokeDasharray="3 3" opacity=".4" />
                      <circle cx="32" cy="32" r="28" strokeWidth="1" strokeDasharray="2 4" opacity=".28" />
                    </svg>
                  </span>
                  <span className="greet">{greeting()}</span>
                  <span className="sub">Message this agent about its current task or research focus.</span>
                </div>
              ) : (
                <div className="messages" ref={messagesRef} onScroll={onMessagesScroll}>
                  {messages.map((m, i) => {
                    const isLast = i === messages.length - 1;
                    // The execution trace is the active turn's: it sits between
                    // the user turn and the agent's reply. On error the empty
                    // agent bubble is dropped, so it falls in after the user turn.
                    const active = trace.length > 0 && phase.status !== "idle" && isLast;
                    const showTraceBefore = active && m.role === "agent";
                    const showTraceAfter = active && m.role === "you" && traceState === "error";
                    return (
                      <Fragment key={i}>
                        {showTraceBefore ? (
                          <AgentExecutionTimeline steps={trace} state={traceState} agentName={agent.name} />
                        ) : null}
                        <MessageRow
                          message={m}
                          onCite={focusNodeByTitle}
                          phase={isLast && m.role !== "you" && phase.status !== "idle" ? phase : undefined}
                          suppressIndicator={showTraceBefore}
                        />
                        {showTraceAfter ? (
                          <AgentExecutionTimeline steps={trace} state={traceState} agentName={agent.name} />
                        ) : null}
                      </Fragment>
                    );
                  })}
                  {awaitingReply && !sending ? (
                    // The transcript ends on an unanswered user turn — its run is
                    // still finishing server-side; this polls and fills it in.
                    <div className="await-reply" data-od-id="awaiting-reply" role="status" aria-live="polite">
                      <span className="ax-live" aria-hidden />
                      The agent is still working on this — its reply will appear here.
                    </div>
                  ) : null}
                  {pendingApproval ? (
                    <div className="approval" data-od-id="approval-prompt" role="alertdialog" aria-label="Tool approval required" ref={approvalRef} tabIndex={-1}>
                      <div className="approval-head">
                        <span className="approval-icon">
                          <IconBolt />
                        </span>
                        <span className="approval-title">
                          {pendingApproval.tool === "run_command" ? "Run this command?" : `Run ${pendingApproval.tool ?? "this tool"}?`}
                        </span>
                      </div>
                      {Object.keys(pendingApproval.args).length ? (
                        <pre className="approval-cmd">{String(pendingApproval.args.command ?? formatArgs(pendingApproval.args))}</pre>
                      ) : null}
                      <div className="approval-actions">
                        <button
                          type="button"
                          className="reg-btn"
                          disabled={sending}
                          onClick={() => void respond("deny")}
                        >
                          Deny
                        </button>
                        <button
                          type="button"
                          className="approve-btn"
                          disabled={sending}
                          onClick={() => void respond("approve")}
                        >
                          <IconCheck />
                          Approve
                        </button>
                      </div>
                    </div>
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
              <div className="composer" data-od-id="composer">
                <div className="composer-box">
                  <textarea
                    className="chat-textarea"
                    rows={1}
                    aria-label="Message this agent"
                    placeholder="Message this agent"
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
                  <div className="composer-row">
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
                      <button className="chip" aria-pressed={chips.reasoning} onClick={() => toggleChip("reasoning")}>
                        <IconSpark />
                        Reasoning
                      </button>
                      <button className="chip" aria-pressed={chips.research} onClick={() => toggleChip("research")}>
                        <IconScreen />
                        Deep research
                      </button>
                    </span>
                    <div className="composer-actions">
                      <span className="send-group">
                        <button
                          className="mic-btn"
                          aria-pressed={micOn}
                          aria-label="Voice input"
                          onClick={toggleMic}
                        >
                          <IconMic />
                        </button>
                        {sending ? (
                          <button className="send-btn can-send stop-btn" aria-label="Stop generating" onClick={stop}>
                            <IconClose />
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
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          {pane === "history" ? (
            <div className="chat-pane active" role="tabpanel" id="panel-history" aria-labelledby="tab-history" data-od-id="chat-history">
              {sessions.length ? (
                sessions.map((s) => (
                  <div className={`hist-row ${s.id === sessionId ? "is-active" : ""}`} key={s.id}>
                    <button className="hist-item" onClick={() => void openSession(s.id)}>
                      <span className="hist-icon">
                        <IconChat />
                      </span>
                      <span className="hist-name">
                        <span className="hist-title">{s.title}</span>
                        <span className="hist-meta">{s.messageCount} messages · {relativeTime(s.updatedAt)}</span>
                      </span>
                    </button>
                    <button
                      className="hist-trash"
                      aria-label={`Delete chat: ${s.title}`}
                      title="Delete this chat"
                      onClick={() => setDeletingSession(s)}
                    >
                      <IconTrash />
                    </button>
                  </div>
                ))
              ) : (
                <div className="activity-empty">No saved chats yet.</div>
              )}
            </div>
          ) : null}

          {pane === "health" ? (
            <div className="chat-pane active" role="tabpanel" id="panel-health" aria-labelledby="tab-health" data-od-id="agent-healthcheck">
              <div className="pane-health active">
                <div className="ah-sec">
                  <h3>Resource meters</h3>
                  {h.meters.length ? (
                    h.meters.map((m) => (
                      <div className="ah-meter" key={m.k}>
                        <span className="m-k">{m.k}</span>
                        <span className="m-track">
                          <span className="m-fill" style={{ width: `${m.pct}%` }} />
                        </span>
                        <span className="m-v">{m.v}</span>
                      </div>
                    ))
                  ) : (
                    <div className="ah-empty">No runtime meters reported yet.</div>
                  )}
                </div>
                <div className="ah-sec">
                  <h3>Recent heartbeats</h3>
                  {h.beats.length ? (
                    h.beats.map((b, i) => (
                      <div className="ah-beat" key={i}>
                        <span className={`ah-dot ${b.cls}`} />
                        <span className="ah-time">{b.time}</span>
                        <span className="ah-text">{b.text}</span>
                      </div>
                    ))
                  ) : (
                    <div className="ah-empty">No heartbeat telemetry yet.</div>
                  )}
                </div>
                <div className="ah-sec">
                  <h3>Incidents</h3>
                  {h.incidents.length ? (
                    h.incidents.map((inc, i) => (
                      <div className="ah-inc" key={i}>
                        <b>{inc.when}</b> — {inc.text}
                      </div>
                    ))
                  ) : (
                    <div className="ah-empty">No incident telemetry reported.</div>
                  )}
                </div>
              </div>
            </div>
          ) : null}

          {pane === "config" ? <AgentConfigPane agentId={agent.id} /> : null}
        </div>
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
    </section>
  );
}

function toUiMessage(m: ChatSessionMessage): ChatMessage {
  return {
    role: m.role === "user" ? "you" : m.role === "system" ? "system" : "agent",
    body: m.content,
    links: m.links ?? undefined,
    stamp: relativeTime(m.createdAt),
  };
}

/** True when the transcript's last real turn is an unanswered user message —
 *  i.e. the run that turn belongs to has not persisted its reply yet. */
function endsUnanswered(msgs: ChatSessionMessage[]): boolean {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "user") return true;
    if (msgs[i].role === "assistant") return false;
  }
  return false;
}

/** Time-of-day greeting for the empty conversation state. */
function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
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

/** Format a tool's args for the approval prompt's command preview. */
function formatArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    if (s === undefined) continue;
    parts.push(`${k}: ${s.length > 60 ? s.slice(0, 57) + "…" : s}`);
  }
  return parts.join(" · ");
}

/** A file attached to the next message; its text is folded into that turn. */
interface AttachedFile {
  name: string;
  text: string;
}
const MAX_ATTACH_BYTES = 50 * 1024;
/** Typewriter reveal pace. A steady ~2 chars/frame (~120 chars/s) reads as
 *  typing and never dumps a chunk instantly, which matters because providers
 *  often deliver reasoning in large blocks. Only a genuinely huge backlog (a
 *  very fast provider) speeds up, and even then it is capped — so text stays
 *  visibly typed while a long answer never lags forever. */
const REVEAL_BASE_PER_FRAME = 2;
const REVEAL_BACKLOG_SOFT = 1000;
const REVEAL_CATCHUP_DIVISOR = 150;
const REVEAL_MAX_PER_FRAME = 14;
const IDLE_PHASE: AgentPhase = { status: "idle", tools: 0 };

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

/** Three pulsing dots + a status word — the "agent is working" indicator. */
function ActivityIndicator({ phase }: { phase: AgentPhase }) {
  const label = phase.status === "researching" ? "Researching…" : "Thinking…";
  return (
    <div className="agent-working" role="status" aria-live="polite">
      <span className="aw-dots" aria-hidden>
        <i />
        <i />
        <i />
      </span>
      <span className="aw-label">{label}</span>
    </div>
  );
}

/** Memoized so the typewriter reveal — which replaces only the last message
 *  object each frame — does not re-render every earlier row in a long chat. */
const MessageRow = memo(function MessageRow({
  message,
  onCite,
  phase,
  suppressIndicator,
}: {
  message: ChatMessage;
  onCite: (t: string) => void;
  phase?: AgentPhase;
  /** the execution timeline above this row already shows the working state */
  suppressIndicator?: boolean;
}) {
  const role = message.role === "you" ? "you" : "agent";
  // LLM output is untrusted: render the safe markdown subset, no raw HTML.
  const html = useMemo(
    () =>
      renderMarkdown(message.body, {
        allowRawHtml: false,
        wiki: (label) => `<button type="button" class="cite" data-cite="${label}">[${label}]</button>`,
      }),
    [message.body],
  );

  const status = phase?.status ?? "idle";
  const reasoningActive = status === "reasoning";
  const generating = status === "generating";
  const working = status === "thinking" || status === "researching";
  const hasReasoning = (message.reasoning?.length ?? 0) > 0;
  const hasBody = message.body.length > 0;
  const showIndicator = !suppressIndicator && working && !hasReasoning && !hasBody;

  // reasoning is forced open while it streams, then collapses on its own; the
  // user can still toggle it afterwards (derived — no effect needed)
  const [userToggledReason, setUserToggledReason] = useState<boolean | null>(null);
  const reasonOpen = reasoningActive ? true : (userToggledReason ?? false);

  return (
    <div className={`message ${role}`}>
      <div className="message-head">
        <span className={`author ${role}`}>{role === "you" ? "You" : message.role === "system" ? "System" : "Agent"}</span>
        {phase && !suppressIndicator && STATE_LABEL[status] ? <span className={`agent-state is-${status}`}>{STATE_LABEL[status]}</span> : null}
        {message.stamp ? <span className="timestamp">{message.stamp}</span> : null}
      </div>
      {showIndicator ? <ActivityIndicator phase={phase!} /> : null}
      {hasReasoning ? (
        <details
          className={`reasoning ${reasoningActive ? "is-active" : "is-settled"}`}
          open={reasonOpen}
          onToggle={(e) => setUserToggledReason((e.currentTarget as HTMLDetailsElement).open)}
        >
          <summary className="reasoning-sum">
            {reasoningActive ? <IconSpark /> : <IconCheck />}
            {reasoningActive ? "Reasoning" : "Reasoning complete"}
          </summary>
          <div className="reasoning-body">
            {message.reasoning}
            {reasoningActive ? <span className="reason-caret" aria-hidden /> : null}
          </div>
        </details>
      ) : null}
      {hasBody || generating ? (
        <div
          className={`message-body md${generating ? " is-streaming" : ""}`}
          onClick={(e) => {
            const el = (e.target as HTMLElement).closest(".cite");
            const title = el?.getAttribute("data-cite");
            if (title) onCite(title);
          }}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : null}
      {message.files?.length ? (
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
  );
});
