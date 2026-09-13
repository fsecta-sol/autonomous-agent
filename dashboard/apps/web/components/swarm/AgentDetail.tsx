"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useWorkspace } from "@/components/providers/workspace";
import {
  streamAgentChat,
  describeLlmError,
  type ChatTurn,
  listChats,
  createChat,
  getChat,
  appendChatMessage,
  deleteChat,
  type ChatSession,
  type ChatSessionMessage,
} from "@/lib/api";
import { LlmError } from "@/lib/llm-client";
import type { ToolStreamEvent } from "@/lib/llm-stream";
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

interface ToolRun {
  key: string;
  name: string;
  args?: Record<string, unknown>;
  status: "running" | "done" | "error";
  result?: string;
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
  /** explicit agent lifecycle — drives the activity indicator and reveal */
  const [phase, setPhase] = useState<AgentPhase>({ status: "idle", tools: 0 });
  const [error, setError] = useState<string | null>(null);
  const [chips, setChips] = useState<Record<string, boolean>>({ reasoning: false, research: false });
  const [attachment, setAttachment] = useState<AttachedFile | null>(null);
  const [micOn, setMicOn] = useState(false);
  const [toolRuns, setToolRuns] = useState<ToolRun[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const messagesRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const runSeq = useRef(0);
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

  useEffect(() => {
    const el = messagesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, sending, toolRuns]);

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
  }, [agent.id]);

  const toggleChip = (k: string) => setChips((prev) => ({ ...prev, [k]: !prev[k] }));

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
  };

  const newChat = async () => {
    abortRef.current?.abort(); // end any in-flight turn before clearing the view
    resetReveal();
    try {
      const detail = await createChat(agent.id);
      setSessionId(detail.id);
      setMessages([]);
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
    try {
      const detail = await getChat(id);
      setSessionId(detail.id);
      setMessages(detail.messages.map(toUiMessage));
      setError(null);
      setPane("conversation");
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
        if (remaining.length) {
          const detail = await getChat(remaining[0].id);
          setSessionId(detail.id);
          setMessages(detail.messages.map(toUiMessage));
        } else {
          setSessionId(null);
          setMessages([]);
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

  const send = async () => {
    const text = input.trim();
    if (text.length < 1 || sending) return;
    setInput("");
    setError(null);
    stopListening(); // a voice capture ends when the message is sent

    // An attached file is folded into this turn's text (no server upload).
    const sent = buildOutgoing(text, attachment);

    // Snapshot the conversation before appending the new turn; roles map
    // you→user, agent→assistant for the model.
    const turns: ChatTurn[] = [
      ...messages.filter((m) => m.role !== "system").map<ChatTurn>((m) => ({
        role: m.role === "you" ? "user" : "assistant",
        content: m.body,
      })),
      { role: "user", content: sent },
    ];

    setSending(true);
    streamActiveRef.current = true;
    turnStreamingRef.current = true;
    reasonFlagsRef.current = { reasoning: 0, text: 0 };
    onRevealDoneRef.current = null;
    setPhase({ status: "thinking", tools: 0 });
    setToolRuns([]);
    setWarnings([]);
    // Append the user turn and an empty agent bubble that the stream fills.
    setMessages((prev) => [
      ...prev,
      { role: "you", body: sent, files: attachment ? [attachment.name] : undefined, stamp: "just now" },
      { role: "agent", body: "", stamp: "just now" },
    ]);
    setAttachment(null);

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    let sid = sessionId;
    let acc = "";
    try {
      if (!sid) {
        const detail = await createChat(agent.id);
        sid = detail.id;
        setSessionId(sid);
        setSessions((prev) => [detail, ...prev]);
      }
      await appendChatMessage(sid, { role: "user", content: text });

      await streamAgentChat(
        { agentId: agent.id, messages: turns, reasoning: chips.reasoning, research: chips.research },
        {
          signal: ctrl.signal,
          onText: (t) => {
            acc += t;
            enqueueReveal("text", t);
          },
          onTool: (e) => {
            applyToolEvent(e, setToolRuns, runSeq);
            if (e.phase === "start") setPhase((p) => (p.status === "reasoning" || p.status === "generating" ? p : { status: "researching", tools: p.tools + 1 }));
          },
          onWarning: (msg) => setWarnings((prev) => (prev.includes(msg) ? prev : [...prev, msg])),
          onReasoning: (t) => {
            enqueueReveal("reasoning", t);
          },
        },
      );
    } catch (err) {
      const aborted = err instanceof LlmError && err.kind === "aborted";
      if (aborted) {
        // stop means stop — show what streamed at once rather than finishing the animation
        flushReveal();
      } else {
        // flush any partial text, then drop the empty agent bubble so the error
        // reads as its own row instead of a blank one
        flushReveal();
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          return last && last.role === "agent" && last.body === "" ? prev.slice(0, -1) : prev;
        });
        setPhase({ status: "error", tools: 0 });
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
      };
      onRevealDoneRef.current = finish;
      // if nothing is left to reveal, or the pump is idle, finalize right away
      if (!revealQueueRef.current.length && revealFrameRef.current === null) {
        onRevealDoneRef.current = null;
        finish();
      }
      streamActiveRef.current = false;
      abortRef.current = null;
      // persist whatever assistant text streamed (including a partial on stop)
      if (sid && acc.trim()) {
        try {
          await appendChatMessage(sid, { role: "assistant", content: acc });
          setSessions(await listChats(agent.id));
        } catch {
          /* history save is best-effort; the reply is already on screen */
        }
      }
    }
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

        <div className="seg" role="tablist" aria-label="Agent workspace">
          <button
            className="seg-btn"
            role="tab"
            aria-selected={pane === "conversation"}
            data-od-id="seg-conversation"
            onClick={() => setPane("conversation")}
          >
            Chat
          </button>
          <button
            className="seg-btn"
            role="tab"
            aria-selected={pane === "history"}
            data-od-id="seg-history"
            onClick={() => setPane("history")}
          >
            History
          </button>
          <button
            className="seg-btn"
            role="tab"
            aria-selected={pane === "health"}
            data-od-id="seg-health"
            onClick={() => setPane("health")}
          >
            Health
          </button>
          <button
            className="seg-btn"
            role="tab"
            aria-selected={pane === "config"}
            data-od-id="seg-config"
            onClick={() => setPane("config")}
          >
            Config
          </button>
        </div>

        <div className="ad-body">
          {pane === "conversation" ? (
            <div className="chat-pane active" role="tabpanel">
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
                  <span className="greet">Good morning</span>
                  <span className="sub">Message this agent about its current task or research focus.</span>
                </div>
              ) : (
                <div className="messages" ref={messagesRef}>
                  {messages.map((m, i) => (
                    <MessageRow
                      key={i}
                      message={m}
                      onCite={focusNodeByTitle}
                      phase={i === messages.length - 1 && m.role !== "you" && phase.status !== "idle" ? phase : undefined}
                    />
                  ))}
                  {toolRuns.length ? (
                    <div className="tool-runs" data-od-id="tool-runs">
                      {toolRuns.map((tr) => (
                        <div className={`tool-run is-${tr.status}`} key={tr.key}>
                          <span className="tr-icon">
                            <IconBolt />
                          </span>
                          <span className="tr-name">{tr.name}</span>
                          <span className="tr-status">
                            {tr.status === "running" ? "running…" : tr.status === "error" ? "failed" : "done"}
                          </span>
                          {tr.args && Object.keys(tr.args).length ? (
                            <span className="tr-args">{formatArgs(tr.args)}</span>
                          ) : null}
                        </div>
                      ))}
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
            <div className="chat-pane active" role="tabpanel" data-od-id="chat-history">
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
            <div className="chat-pane active" role="tabpanel" data-od-id="agent-healthcheck">
              <div className="pane-health active">
                <div className="ah-sec">
                  <h3>Resource meters</h3>
                  {h.meters.map((m) => (
                    <div className="ah-meter" key={m.k}>
                      <span className="m-k">{m.k}</span>
                      <span className="m-track">
                        <span className="m-fill" style={{ width: `${m.pct}%` }} />
                      </span>
                      <span className="m-v">{m.v}</span>
                    </div>
                  ))}
                </div>
                <div className="ah-sec">
                  <h3>Recent heartbeats</h3>
                  {h.beats.map((b, i) => (
                    <div className="ah-beat" key={i}>
                      <span className={`ah-dot ${b.cls}`} />
                      <span className="ah-time">{b.time}</span>
                      <span className="ah-text">{b.text}</span>
                    </div>
                  ))}
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
                    <div className="ah-empty">No incidents in the last 30 days.</div>
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

/** Fold a tool start/end event into the run list (end updates the active run). */
function applyToolEvent(
  e: ToolStreamEvent,
  setRuns: (updater: (prev: ToolRun[]) => ToolRun[]) => void,
  seq: { current: number },
): void {
  if (e.phase === "start") {
    const key = `${e.name}-${seq.current++}`;
    setRuns((prev) => [...prev, { key, name: e.name, args: e.args, status: "running" }]);
    return;
  }
  setRuns((prev) => {
    const copy = prev.slice();
    for (let i = copy.length - 1; i >= 0; i--) {
      if (copy[i].name === e.name && copy[i].status === "running") {
        copy[i] = { ...copy[i], status: e.error ? "error" : "done", result: e.result };
        break;
      }
    }
    return copy;
  });
}

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

function MessageRow({ message, onCite, phase }: { message: ChatMessage; onCite: (t: string) => void; phase?: AgentPhase }) {
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
  const showIndicator = working && !hasReasoning && !hasBody;

  // reasoning is forced open while it streams, then collapses on its own; the
  // user can still toggle it afterwards (derived — no effect needed)
  const [userToggledReason, setUserToggledReason] = useState<boolean | null>(null);
  const reasonOpen = reasoningActive ? true : (userToggledReason ?? false);

  return (
    <div className={`message ${role}`}>
      <div className="message-head">
        <span className={`author ${role}`}>{role === "you" ? "You" : message.role === "system" ? "System" : "Agent"}</span>
        {phase && STATE_LABEL[status] ? <span className={`agent-state is-${status}`}>{STATE_LABEL[status]}</span> : null}
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
}
