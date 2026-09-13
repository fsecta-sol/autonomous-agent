"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import type { GraphData } from "@dashboard/shared";
import type { ActivityDay, Agent, KnowledgeNode, PipelineRun, SwarmActivityItem } from "@dashboard/shared";
import { fetchActivityDays, fetchAgents, fetchGraphData, fetchPipelines } from "@/lib/api";
import { subscribeSwarmActivity } from "@/lib/live";
import type { GraphEngine } from "@/components/graph/engine";

export type ViewName =
  | "graph"
  | "map"
  | "inbox"
  | "activity"
  | "research"
  | "swarm"
  | "orchestration"
  | "profile"
  | "settings";

export type LoadState = "loading" | "success" | "error";

export interface ReaderDoc {
  title: string;
  kind: string;
  body: string;
  /** key of the index entry to mark active, when opened from the list */
  activeKey?: string | null;
}

interface WorkspaceValue {
  view: ViewName;
  setView: (v: ViewName) => void;
  settingsMode: boolean;

  graphState: LoadState;
  graph: GraphData | null;
  graphError: string | null;
  reloadGraph: () => void;

  agents: Agent[];
  updateAgent: (id: string, patch: Partial<Agent>) => void;
  /** re-read the roster from the server (after create/delete) */
  refreshAgents: () => Promise<void>;
  /** prepend a newly created agent without a refetch */
  addAgent: (a: Agent) => void;
  /** drop an agent locally without a refetch */
  removeAgent: (id: string) => void;

  activityDays: ActivityDay[];
  pipelines: PipelineRun[];

  feedLive: boolean;
  setFeedLive: (v: boolean) => void;
  /** stable ref read by the graph loop each frame (avoids re-renders) */
  liveRef: RefObject<boolean>;

  swarmActivity: SwarmActivityItem[];
  dismissActivity: (id: string) => void;

  /** the mounted graph engine, if any */
  engine: GraphEngine | null;
  registerEngine: (e: GraphEngine | null) => void;
  /** request the graph view focus a node by title once mounted */
  focusRequest: { title: string; nonce: number } | null;
  focusNodeByTitle: (title: string) => void;

  reader: ReaderDoc | null;
  openReader: (doc: ReaderDoc) => void;
  closeReader: () => void;

  selectedAgentId: string | null;
  openAgent: (id: string) => void;
  closeAgent: () => void;

  graphFocusMode: boolean;
  setGraphFocusMode: (v: boolean) => void;
}

const WorkspaceContext = createContext<WorkspaceValue | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [view, setViewState] = useState<ViewName>("graph");
  const [graphState, setGraphState] = useState<LoadState>("loading");
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [graphError, setGraphError] = useState<string | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [activityDays, setActivityDays] = useState<ActivityDay[]>([]);
  const [pipelines, setPipelines] = useState<PipelineRun[]>([]);
  const [feedLive, setFeedLiveState] = useState(true);
  const [swarmActivity, setSwarmActivity] = useState<SwarmActivityItem[]>([]);
  const [engine, setEngine] = useState<GraphEngine | null>(null);
  const [focusRequest, setFocusRequest] = useState<{ title: string; nonce: number } | null>(null);
  const [reader, setReader] = useState<ReaderDoc | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [graphFocusMode, setGraphFocusMode] = useState(false);

  const loadToken = useRef(0);
  const liveRef = useRef(true);

  // the fetch itself never sets state synchronously, so it is safe to call
  // from an effect; the retry handler flips the loading state first.
  const runGraphFetch = useCallback((token: number) => {
    fetchGraphData()
      .then((data) => {
        if (token !== loadToken.current) return;
        setGraph(data);
        setGraphState("success");
      })
      .catch((err: unknown) => {
        if (token !== loadToken.current) return;
        setGraphError(err instanceof Error ? err.message : "The knowledge graph could not be assembled.");
        setGraphState("error");
      });
  }, []);

  const loadGraph = useCallback(() => {
    const token = ++loadToken.current;
    setGraphState("loading");
    setGraphError(null);
    runGraphFetch(token);
  }, [runGraphFetch]);

  useEffect(() => {
    const token = ++loadToken.current;
    runGraphFetch(token);
    let cancelled = false;
    Promise.all([fetchAgents(), fetchActivityDays(), fetchPipelines()]).then(([a, d, p]) => {
      if (cancelled) return;
      setAgents(a.map((x) => ({ ...x })));
      setActivityDays(d);
      setPipelines(p);
    });
    return () => {
      cancelled = true;
    };
  }, [runGraphFetch]);

  // swarm activity stream — replaceable transport, see lib/live.ts.
  // Wiring is transport-only: new items prepend while the feed is live.
  useEffect(() => {
    const sub = subscribeSwarmActivity((item) => {
      if (!liveRef.current) return;
      setSwarmActivity((prev) => [item, ...prev].slice(0, 30));
    });
    return () => sub.unsubscribe();
  }, []);

  const setFeedLive = useCallback((v: boolean) => {
    liveRef.current = v;
    setFeedLiveState(v);
  }, []);

  const dismissActivity = useCallback((id: string) => {
    setSwarmActivity((prev) => prev.filter((x) => x.id !== id));
  }, []);

  const updateAgent = useCallback((id: string, patch: Partial<Agent>) => {
    setAgents((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  }, []);

  const refreshAgents = useCallback(async () => {
    try {
      setAgents(await fetchAgents());
    } catch {
      /* leave the current roster if the refetch fails */
    }
  }, []);

  const addAgent = useCallback((a: Agent) => {
    setAgents((prev) => [a, ...prev.filter((x) => x.id !== a.id)]);
  }, []);

  const removeAgent = useCallback((id: string) => {
    setAgents((prev) => prev.filter((x) => x.id !== id));
  }, []);

  const setView = useCallback((v: ViewName) => {
    setViewState(v);
    if (v !== "graph") setReader(null);
    if (v !== "swarm") setSelectedAgentId(null);
  }, []);

  const registerEngine = useCallback((e: GraphEngine | null) => {
    setEngine(e);
  }, []);

  const focusNodeByTitle = useCallback((title: string) => {
    setViewState("graph");
    setFocusRequest({ title, nonce: Date.now() });
  }, []);

  const openReader = useCallback((doc: ReaderDoc) => {
    setReader(doc);
    setViewState("graph");
  }, []);
  const closeReader = useCallback(() => setReader(null), []);

  const openAgent = useCallback((id: string) => setSelectedAgentId(id), []);
  const closeAgent = useCallback(() => setSelectedAgentId(null), []);

  const settingsMode = view === "profile" || view === "settings";

  const value = useMemo<WorkspaceValue>(
    () => ({
      view,
      setView,
      settingsMode,
      graphState,
      graph,
      graphError,
      reloadGraph: loadGraph,
      agents,
      updateAgent,
      refreshAgents,
      addAgent,
      removeAgent,
      activityDays,
      pipelines,
      feedLive,
      setFeedLive,
      liveRef,
      swarmActivity,
      dismissActivity,
      engine,
      registerEngine,
      focusRequest,
      focusNodeByTitle,
      reader,
      openReader,
      closeReader,
      selectedAgentId,
      openAgent,
      closeAgent,
      graphFocusMode,
      setGraphFocusMode,
    }),
    [
      view,
      setView,
      settingsMode,
      graphState,
      graph,
      graphError,
      loadGraph,
      agents,
      updateAgent,
      refreshAgents,
      addAgent,
      removeAgent,
      activityDays,
      pipelines,
      feedLive,
      setFeedLive,
      swarmActivity,
      dismissActivity,
      engine,
      registerEngine,
      focusRequest,
      focusNodeByTitle,
      reader,
      openReader,
      closeReader,
      selectedAgentId,
      openAgent,
      closeAgent,
      graphFocusMode,
    ],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace must be used within WorkspaceProvider");
  return ctx;
}

export function useNodeByTitle(graph: GraphData | null, title: string | null): KnowledgeNode | null {
  return useMemo(() => {
    if (!graph || !title) return null;
    return graph.nodes.find((n) => n.label === title) ?? null;
  }, [graph, title]);
}
