"use client";

import { AppShell } from "@/components/layout/AppShell";
import { WorkspaceProvider, useWorkspace } from "@/components/providers/workspace";
import { useAuth } from "@/components/providers/auth";
import { KnowledgeGraph } from "@/components/graph/KnowledgeGraph";
import { MapView } from "@/components/map/MapView";
import { InboxView } from "@/components/inbox/InboxView";
import { ActivityView } from "@/components/activity/ActivityView";
import { ResearchView } from "@/components/research/ResearchView";
import { SwarmView } from "@/components/swarm/SwarmView";
import { OrchestrationView } from "@/components/orchestration/OrchestrationView";
import { SchedulerView } from "@/components/scheduler/SchedulerView";
import { ProfileView } from "@/components/settings/ProfileView";
import { SettingsView } from "@/components/settings/SettingsView";

export function WorkspaceClient() {
  // The authoritative gate lives on the server (app/page.tsx validates the
  // session before this renders); here we only wait for `/me` to resolve so
  // the shell doesn't flash before the operator profile is known.
  const { loading, authed } = useAuth();

  if (loading || !authed) {
    return (
      <div
        style={{
          height: "100vh",
          display: "grid",
          placeItems: "center",
          color: "var(--muted)",
          fontFamily: "var(--font-plex-mono), monospace",
          fontSize: 11,
          letterSpacing: ".08em",
          textTransform: "uppercase",
        }}
      >
        Opening command workspace…
      </div>
    );
  }

  return (
    <WorkspaceProvider>
      <AppShell>
        <ViewStack />
      </AppShell>
    </WorkspaceProvider>
  );
}

/**
 * All views stay mounted so the canvas engine keeps its state across
 * navigation; only the active one renders its UI. This mirrors the reference's
 * `.view.active` toggle without rebuilding the graph every time.
 */
function ViewStack() {
  const { view } = useWorkspace();
  return (
    <>
      {/* always mounted — the engine keeps its state across navigation */}
      <KnowledgeGraph />
      {view === "map" ? <MapView /> : null}
      {view === "inbox" ? <InboxView /> : null}
      {view === "activity" ? <ActivityView /> : null}
      {view === "research" ? <ResearchView /> : null}
      {view === "swarm" ? <SwarmView /> : null}
      {view === "orchestration" ? <OrchestrationView /> : null}
      {view === "scheduler" ? <SchedulerView /> : null}
      {view === "profile" ? <ProfileView /> : null}
      {view === "settings" ? <SettingsView /> : null}
    </>
  );
}
