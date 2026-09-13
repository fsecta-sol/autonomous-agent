"use client";

import { useWorkspace, type ViewName } from "@/components/providers/workspace";
import {
  IconActivity,
  IconAppearance,
  IconChevronLeft,
  IconClock,
  IconGraph,
  IconInbox,
  IconMap,
  IconOrchestration,
  IconPlug,
  IconProfileSmall,
  IconResearch,
  IconSwarm,
} from "@/components/ui/icons";

interface NavEntry {
  view: ViewName;
  label: string;
  icon: React.ReactNode;
  badge?: number;
}

const MAIN: Omit<NavEntry, "icon">[] = [
  { view: "graph", label: "Graph" },
  { view: "map", label: "Map" },
  { view: "inbox", label: "Inbox" },
  { view: "activity", label: "Activity" },
  { view: "research", label: "Research" },
  { view: "swarm", label: "Swarm" },
  { view: "orchestration", label: "Orchestration" },
];

const ICONS: Record<string, React.ReactNode> = {
  graph: <IconGraph />,
  map: <IconMap />,
  inbox: <IconInbox />,
  activity: <IconActivity />,
  research: <IconResearch />,
  swarm: <IconSwarm />,
  orchestration: <IconOrchestration />,
};

interface NavRailProps {
  collapsed: boolean;
  onToggle: () => void;
  mobileOpen: boolean;
  inboxCount: number;
}

export function NavRail({ collapsed, onToggle, mobileOpen, inboxCount }: NavRailProps) {
  const { view, setView, settingsMode } = useWorkspace();
  const expanded = mobileOpen || !collapsed;

  return (
    <aside
      className={`nav-rail ${collapsed && !mobileOpen ? "collapsed" : ""} ${settingsMode ? "settings-mode" : ""}`}
      aria-label="Workspace views"
      aria-hidden={!expanded && mobileOpen ? false : undefined}
    >
      <nav className="main-nav" aria-label="Workspace views">
        {MAIN.map((entry) => {
          const active = view === entry.view;
          return (
            <button
              key={entry.view}
              type="button"
              className={`nav-item ${active ? "is-active" : ""} ${entry.view === "inbox" ? "settings-anchor" : ""}`}
              onClick={() => setView(entry.view)}
              title={!expanded ? entry.label : undefined}
              aria-current={active ? "page" : undefined}
            >
              <span className="nav-icon">{ICONS[entry.view]}</span>
              <span className="nav-label">{entry.label}</span>
              {entry.view === "inbox" && inboxCount > 0 ? <span className="nav-badge">{inboxCount}</span> : null}
            </button>
          );
        })}
      </nav>

      <nav className="settings-nav" aria-label="Settings sections">
        <button type="button" className="nav-item" onClick={() => setView("graph")} title={!expanded ? "Back to workspace" : undefined}>
          <span className="nav-icon">
            <IconChevronLeft />
          </span>
          <span className="nav-label">Back to workspace</span>
        </button>
        <button
          type="button"
          className={`settings-link ${view === "profile" ? "is-active" : ""}`}
          onClick={() => setView("profile")}
        >
          <span className="nav-icon">
            <IconProfileSmall />
          </span>
          <span className="nav-label">Profile</span>
        </button>
        <span className="settings-section-label">Settings</span>
        <button
          type="button"
          className={`settings-link ${view === "settings" ? "is-active" : ""}`}
          onClick={() => setView("settings")}
        >
          <span className="nav-icon">
            <IconPlug />
          </span>
          <span className="nav-label">AI connection</span>
        </button>
        <button type="button" className="settings-link" onClick={() => setView("settings")}>
          <span className="nav-icon">
            <IconAppearance />
          </span>
          <span className="nav-label">Appearance</span>
        </button>
        <button type="button" className="settings-link" onClick={() => setView("settings")}>
          <span className="nav-icon">
            <IconClock />
          </span>
          <span className="nav-label">Swarm schedule</span>
        </button>
      </nav>

      <button
        type="button"
        className="nav-collapse-btn nav-toggle"
        aria-label={collapsed ? "Expand menu" : "Collapse menu"}
        title={collapsed ? "Expand menu" : "Collapse menu"}
        aria-expanded={!collapsed}
        onClick={onToggle}
      >
        <span className="nav-icon">
          <span className="nav-toggle-icon" style={{ display: "contents" }}>
            <IconChevronLeft />
          </span>
        </span>
        <span className="nav-label">Collapse</span>
      </button>
    </aside>
  );
}
