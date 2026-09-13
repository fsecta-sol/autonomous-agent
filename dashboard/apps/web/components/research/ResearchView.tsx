"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWorkspace } from "@/components/providers/workspace";
import { ThoughtThread } from "./ThoughtThread";
import { runResearch, describeLlmError } from "@/lib/api";
import { LlmError } from "@/lib/llm-client";
import { conceptTitle, findConnections, shortRestate } from "@/lib/research";
import { IconArrowRight } from "@/components/ui/icons";
import type { ChatMessage, Thought } from "@dashboard/shared";

type Depth = "quick" | "standard" | "deep";
type StatusFilter = "all" | "linked" | "standalone" | "researching";

const STATUS_LABEL: Record<Thought["status"], string> = {
  researching: "Researching",
  linked: "Linked",
  standalone: "Standalone",
};

let seq = 0;

export function ResearchView() {
  const { graph, engine, agents } = useWorkspace();

  const [thoughts, setThoughts] = useState<Thought[]>([]);
  const [openId, setOpenId] = useState<number | null>(null);
  const [filterText, setFilterText] = useState("");
  const [filterStatus, setFilterStatus] = useState<StatusFilter>("all");
  const [input, setInput] = useState("");
  const [depth, setDepth] = useState<Depth>("standard");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  const seeded = useRef(false);

  const connectionsOf = useCallback(
    (text: string, limit: number) => (graph ? findConnections(graph, text, limit) : []),
    [graph],
  );

  const titlesOf = useCallback(
    (conn: number[]) => (graph ? conn.map((i) => graph.nodes[i].label) : []),
    [graph],
  );

  // seed a few thoughts so the filters have something to bite on
  useEffect(() => {
    if (seeded.current || !graph) return;
    seeded.current = true;
    const mk = (text: string, d: Depth, match: string | null, force?: Thought["status"]): Thought => {
      const conn = force === "standalone" ? [] : findConnections(graph, match || text, 3);
      const status = force ?? (conn.length ? "linked" : "standalone");
      const messages: ChatMessage[] = [
        { role: "you", body: text, stamp: "09:12" },
        { role: "agent", body: "Framed the question and scanned the vault.", stamp: "09:12" },
      ];
      if (status === "linked") {
        messages.push({ role: "agent", body: `Closest existing notes: ${conn.map((i) => graph.nodes[i].label).map((t) => `[[${t}]]`).join(", ")}.`, links: conn.map((i) => graph.nodes[i].label), stamp: "09:12" });
        messages.push({ role: "agent", body: "This concept already lives in the graph — I reinforced its links rather than adding a duplicate node.", links: conn.map((i) => graph.nodes[i].label), openIdx: conn[0], stamp: "09:13" });
      } else if (status === "researching") {
        messages.push({ role: "agent", body: `Scanned the vault — ${conn.length} related note${conn.length > 1 ? "s" : ""}: ${titlesOf(conn).map((t) => `[[${t}]]`).join(", ")}.`, links: titlesOf(conn), stamp: "09:13" });
      } else {
        messages.push({ role: "agent", body: "No strong match in the current graph. Kept as a standalone thought — reword it around a concept the vault covers to link it in.", stamp: "09:12" });
      }
      seq += 1;
      return { id: seq, text, depth: d, status, conn, nodeIdx: null, stamp: "09:12", ts: Date.now() - seq * 60000, messages };
    };
    setThoughts([
      mk("How does MEV-Boost change the way blocks get built?", "standard", "MEV-Boost relay proposer builder separation block building"),
      mk("What keeps a stablecoin pegged when the market runs?", "deep", "stablecoin peg mechanism algorithmic collateral"),
      mk("Could an autonomous agent hold its own keys safely?", "standard", "autonomous agent custody wallet permissions verifiable computation"),
      mk("Why do perp funding rates flip negative in a bull market?", "deep", "funding rate perpetual futures open interest skew", "researching"),
      mk("How does data availability sampling prove a blob is really there?", "standard", "data availability sampling danksharding blob", "researching"),
      mk("Should I journal trades by emotion or by setup?", "quick", null, "standalone"),
      mk("Weekend idea: a dashboard that only surfaces what changed overnight", "standard", null, "standalone"),
      mk("Is there a word for the regret of a chart you almost shorted?", "quick", null, "standalone"),
    ]);
  }, [graph, titlesOf]);

  const rows = useMemo(() => {
    const q = filterText.toLowerCase();
    return [...thoughts]
      .sort((a, b) => b.ts - a.ts)
      .filter((t) => {
        if (filterStatus !== "all" && t.status !== filterStatus) return false;
        if (q && t.text.toLowerCase().indexOf(q) === -1) return false;
        return true;
      });
  }, [thoughts, filterText, filterStatus]);

  const current = openId != null ? thoughts.find((t) => t.id === openId) ?? null : null;

  const updateThought = useCallback((id: number, patch: Partial<Thought>) => {
    setThoughts((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  const pushMessage = useCallback((id: number, msg: ChatMessage) => {
    setThoughts((prev) => prev.map((t) => (t.id === id ? { ...t, messages: [...t.messages, msg] } : t)));
  }, []);

  const runThought = useCallback(
    async (text: string, d: Depth) => {
      if (!graph) return;
      setError(null);
      const t: Thought = {
        id: ++seq,
        text,
        depth: d,
        status: "researching",
        conn: [],
        nodeIdx: null,
        stamp: "just now",
        ts: Date.now(),
        messages: [{ role: "you", body: text, stamp: "just now" }],
      };
      setThoughts((prev) => [t, ...prev]);
      setOpenId(t.id);
      setRunning(true);

      const conn = connectionsOf(text, d === "deep" ? 4 : 3);
      const connTitles = titlesOf(conn);

      const fail = (err: unknown) => {
        setRunning(false);
        const msg = describeLlmError(err);
        setError(msg);
        pushMessage(t.id, { role: "system", body: msg, stamp: "just now" });
      };

      try {
        const abort = new AbortController();
        // With a connection configured, runResearch POSTs under the 30-attempt
        // timeout retry budget. Without one it throws a "no connection" LlmError,
        // which is the normal local path — fall back to the vault matcher. A
        // timeout/network failure that exhausted its retries is a real error and
        // must surface, not be silently downgraded.
        let res: Awaited<ReturnType<typeof runResearch>> | null = null;
        try {
          res = await runResearch({ thought: text, depth: d }, abort.signal);
        } catch (err) {
          const noConnection = err instanceof LlmError && err.kind === "http" && err.status === undefined;
          if (!noConnection) throw err;
        }
        const links = res?.connections?.length ? res.connections : connTitles;
        const summary = res?.summary ?? null;

        // stage the run so it reads as an agent working through the thought
        pushMessage(t.id, { role: "agent", body: `Framing the question — ${shortRestate(text)}.`, stamp: "just now" });
        updateThought(t.id, { conn });

        await pause(600);
        pushMessage(
          t.id,
          links.length
            ? { role: "agent", body: `Scanned the vault — ${links.length} related note${links.length > 1 ? "s" : ""}: ${links.map((x) => `[[${x}]]`).join(", ")}.`, links, stamp: "just now" }
            : { role: "agent", body: "Scanned the vault — no strong match for this wording.", stamp: "just now" },
        );

        if (d !== "quick") {
          await pause(600);
          pushMessage(t.id, {
            role: "agent",
            body: summary
              ? summary
              : links.length
                ? `Synthesized — it sits closest to ${links.slice(0, 2).map((x) => `[[${x}]]`).join(" and ")} in the ${graph.nodes[conn[0]]?.layer ?? "cross-cutting"} layer.`
                : "Synthesized — the idea stands on its own for now; nothing in the vault anchors it yet.",
            stamp: "just now",
          });
        }

        await pause(600);
        if (links.length && engine) {
          const ingestAgent =
            agents.find((a) => a.currentNode && links.includes(a.currentNode))?.name ?? "Kai";
          const title = conceptTitle(text);
          engine.runIngestChoreography(title, conn, ingestAgent, (newIdx) => {
            updateThought(t.id, { status: "linked", nodeIdx: newIdx, conn });
          });
          updateThought(t.id, { status: "linked", conn, nodeIdx: conn[0] });
          pushMessage(t.id, {
            role: "agent",
            body: `Linked [[${title}]] into the knowledge graph, next to ${connTitles.map((x) => `[[${x}]]`).join(", ")}.`,
            links: connTitles,
            openIdx: conn[0],
            stamp: "just now",
          });
        } else {
          updateThought(t.id, { status: "standalone" });
          pushMessage(t.id, {
            role: "agent",
            body: "No strong connection to the current graph — kept as a standalone thought. Reword it around a concept the vault already covers to link it in.",
            stamp: "just now",
          });
        }
        setRunning(false);
        setRetrying(false);
      } catch (err) {
        fail(err);
      }
    },
    [agents, connectionsOf, engine, graph, pushMessage, titlesOf, updateThought],
  );

  const onRun = () => {
    const text = input.trim();
    if (text.length < 4 || running) return;
    setInput("");
    void runThought(text, depth);
  };

  const onRetry = () => {
    if (!error || !current) return;
    setRetrying(true);
    void runThought(current.text, current.depth);
  };

  const followUp = useCallback(
    async (q: string) => {
      if (!current || !graph) return;
      pushMessage(current.id, { role: "you", body: q, stamp: "just now" });
      await pause(640);
      const more = connectionsOf(q, 3).filter((j) => !current.conn.includes(j));
      if (more.length) {
        pushMessage(current.id, {
          role: "agent",
          body: `From that angle the vault also has ${titlesOf(more).map((x) => `[[${x}]]`).join(", ")}. Open any of them from the graph to compare.`,
          links: titlesOf(more),
          openIdx: more[0],
          stamp: "just now",
        });
      } else {
        pushMessage(current.id, { role: "agent", body: "Noted under this thought. Nothing new in the vault to link from that wording.", stamp: "just now" });
      }
    },
    [connectionsOf, current, graph, pushMessage, titlesOf],
  );

  return (
    <section className="view active" data-od-id="view-research">
      {!current ? (
        <div className="research-index">
          <div className="panel-header">
            <h2>Research</h2>
            <div className="graph-meta">
              <span>Each thought gets its own agent thread → append to the knowledge graph</span>
            </div>
          </div>
          <div className="research-composer" data-od-id="research-composer">
            <label className="rc-label" htmlFor="rc-input">
              What do you want to understand?
            </label>
            <div className="rc-field">
              <textarea
                id="rc-input"
                className="rc-input"
                rows={2}
                placeholder="e.g. How does an AMM price a token swap under the hood?"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    onRun();
                  }
                }}
              />
              <div className="rc-row">
                <select
                  className="rc-depth"
                  aria-label="Research depth"
                  value={depth}
                  onChange={(e) => setDepth(e.target.value as Depth)}
                >
                  <option value="quick">Quick scan</option>
                  <option value="standard">Standard</option>
                  <option value="deep">Deep dive</option>
                </select>
                <button className="rc-run" type="button" disabled={input.trim().length < 4 || running} onClick={onRun}>
                  <IconArrowRight />
                  {running ? "Running…" : "Run research"}
                </button>
              </div>
            </div>
          </div>
          <div className="research-filter">
            <input
              className="rt-filter"
              type="text"
              placeholder="Filter thoughts…"
              aria-label="Filter thoughts"
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
            />
            <div className="rt-fchips" role="group" aria-label="Filter by status">
              {(["all", "linked", "standalone", "researching"] as StatusFilter[]).map((f) => (
                <button
                  type="button"
                  className="rt-fchip"
                  key={f}
                  aria-pressed={filterStatus === f}
                  onClick={() => setFilterStatus(f)}
                >
                  {f.charAt(0).toUpperCase() + f.slice(1)}
                </button>
              ))}
            </div>
          </div>
          <div className="research-list">
            {rows.map((t) => (
              <button type="button" className="rt-row" key={t.id} onClick={() => setOpenId(t.id)}>
                <span className="rt-row-main">
                  <span className="rt-row-text">{t.text}</span>
                  <span className="rt-row-meta">
                    {t.depth} · {t.stamp} ·{" "}
                    {t.status === "linked"
                      ? `linked to ${t.conn.length} note${t.conn.length > 1 ? "s" : ""}`
                      : t.status === "researching"
                        ? "in progress"
                        : "standalone"}
                  </span>
                </span>
                <span className={`rt-status ${t.status === "linked" ? "is-linked" : t.status === "researching" ? "is-running" : ""}`}>
                  {STATUS_LABEL[t.status].toUpperCase()}
                </span>
                <span className="rt-chevron">
                  <IconArrowRight style={{ width: 12, height: 12 }} />
                </span>
              </button>
            ))}
            {!rows.length ? <div className="research-empty">No thoughts match this filter.</div> : null}
          </div>
        </div>
      ) : (
        <ThoughtThread
          thought={current}
          running={running}
          error={error}
          retrying={retrying}
          onBack={() => setOpenId(null)}
          onFollowUp={followUp}
          onRetry={onRetry}
        />
      )}
    </section>
  );
}

function pause(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
