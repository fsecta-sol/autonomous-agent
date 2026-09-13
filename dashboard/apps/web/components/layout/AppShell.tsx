"use client";

import { useState } from "react";
import { NavRail } from "@/components/navigation/NavRail";
import { HealthStrip } from "@/components/navigation/HealthStrip";
import { TopBar } from "@/components/navigation/TopBar";
import { useWorkspace } from "@/components/providers/workspace";
import { useMediaQuery } from "@/lib/client-store";
import { INBOX_PENDING } from "@/lib/store";

export function AppShell({ children }: { children: React.ReactNode }) {
  const { graphFocusMode, settingsMode } = useWorkspace();
  const isMobile = useMediaQuery("(max-width: 900px)");
  // null = follow the viewport; a boolean = the operator's explicit choice
  const [collapsedPref, setCollapsedPref] = useState<boolean | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const collapsed = collapsedPref ?? isMobile;

  const veilOn = isMobile && mobileOpen;

  return (
    <div className="app" data-focus={graphFocusMode ? "graph" : undefined} tabIndex={-1}>
      <TopBar />
      <main className="workspace">
        <NavRail
          collapsed={collapsed}
          onToggle={() => {
            if (isMobile) setMobileOpen((v) => !v);
            else setCollapsedPref(!collapsed);
          }}
          mobileOpen={mobileOpen}
          inboxCount={INBOX_PENDING.length}
        />
        <div className="stage">
          {!graphFocusMode && !settingsMode ? <HealthStrip /> : null}
          <div className="stage-views">{children}</div>
        </div>
      </main>
      {veilOn ? (
        <button
          type="button"
          className="veil"
          aria-label="Close navigation"
          style={{ border: 0, cursor: "default" }}
          onClick={() => setMobileOpen(false)}
        />
      ) : null}
    </div>
  );
}
