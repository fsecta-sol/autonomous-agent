"use client";

import { useRouter } from "next/navigation";
import { useRef } from "react";
import { useAuth } from "@/components/providers/auth";
import { useTheme } from "@/components/providers/theme";
import { useWorkspace } from "@/components/providers/workspace";
import { useDismissible } from "@/components/ui/useDropdown";
import { IconFlag, IconMinimize, IconMoon, IconProfileSmall, IconSun } from "@/components/ui/icons";
import { DANGLING, REVIEW_TITLES } from "@/lib/store";
import { DOCS } from "@/lib/docs";

export function TopBar() {
  const router = useRouter();
  const { theme, toggle } = useTheme();
  const { profile, signOut } = useAuth();
  const { setView, focusNodeByTitle, openReader, graphFocusMode, setGraphFocusMode } = useWorkspace();
  const flagsRef = useRef<HTMLDivElement | null>(null);
  const userRef = useRef<HTMLDivElement | null>(null);
  const flags = useDismissible(flagsRef);
  const user = useDismissible(userRef);

  const nextTheme = theme === "light" ? "dark" : "light";

  const reviewItems = REVIEW_TITLES.map((title) => ({
    title,
    markers: title === "Copy Trading" ? ["NEEDS-CLASSIFICATION"] : title === "Block Production" ? ["NEEDS-WHY", "NEEDS-EXAMPLES"] : [],
  }));

  return (
    <header className="topbar" data-od-id="topbar">
      <div className="topbar-brand">
        <span className="wordmark" data-od-id="wordmark">
          Autonomous Agent V0
        </span>
      </div>
      <div className="topbar-actions">
        {graphFocusMode ? (
          <button
            type="button"
            className="focus-exit"
            aria-label="Exit full screen"
            title="Exit full screen (Esc)"
            onClick={() => setGraphFocusMode(false)}
          >
            <IconMinimize />
            Exit full screen
            <kbd>Esc</kbd>
          </button>
        ) : null}
        <div className="flags-wrap" ref={flagsRef} data-od-id="flags-wrap">
          <button
            type="button"
            className="flags-btn"
            aria-haspopup="menu"
            aria-expanded={flags.open}
            aria-label={`${reviewItems.length} notes need review`}
            title={`${reviewItems.length} notes need review`}
            onClick={flags.toggle}
          >
            <IconFlag />
            <span className="flags-n">{reviewItems.length}</span>
          </button>
          {flags.open ? (
            <div className="flags-menu" role="menu">
              <div className="flags-menu-head">Needs review · {reviewItems.length}</div>
              {reviewItems.map((item) => (
                <div className="rv-item" key={item.title}>
                  <div className="rv-title">{item.title}</div>
                  <div className="rv-badges">
                    {item.markers.length ? (
                      item.markers.map((m) => (
                        <span className="rv-badge" key={m}>
                          [{m}]
                        </span>
                      ))
                    ) : (
                      <span className="rv-badge">flagged</span>
                    )}
                  </div>
                  <div className="rv-actions">
                    <button
                      type="button"
                      onClick={() => {
                        flags.close();
                        focusNodeByTitle(item.title);
                      }}
                    >
                      Open in graph
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        flags.close();
                        const key = Object.keys(DOCS).find((k) => DOCS[k].title === item.title);
                        if (key) {
                          const d = DOCS[key];
                          openReader({ title: d.file, kind: "note", body: d.body, activeKey: null });
                        } else {
                          focusNodeByTitle(item.title);
                        }
                      }}
                    >
                      Read note
                    </button>
                  </div>
                </div>
              ))}
              <div className="flags-menu-sub">Dangling references</div>
              <div className="rv-dangling">
                <span className="rv-ref rv-ref-miss">lapis ×2</span>
                <span className="rv-note">missing target — flagged by graph-walker</span>
              </div>
              <div className="rv-dangling">
                {DANGLING.routed.map((x) => (
                  <span className="rv-ref" key={x}>
                    {x}
                  </span>
                ))}
                <span className="rv-note">routed to project pages — not errors</span>
              </div>
            </div>
          ) : null}
        </div>

        <button
          type="button"
          className="icon-btn"
          data-od-id="theme-toggle"
          aria-label={`Switch to ${nextTheme} theme`}
          title={`Switch to ${nextTheme} theme`}
          onClick={toggle}
        >
          {theme === "light" ? (
            <span className="theme-icon-light" style={{ display: "contents" }}>
              <IconSun />
            </span>
          ) : (
            <span className="theme-icon-dark" style={{ display: "contents" }}>
              <IconMoon />
            </span>
          )}
        </button>

        <div className="user-wrap" ref={userRef} data-od-id="user-menu-wrap">
          <button
            type="button"
            className="user-btn"
            aria-haspopup="menu"
            aria-expanded={user.open}
            aria-label={`Account menu, ${profile?.name ? profile.name : "not signed in"}`}
            onClick={user.toggle}
          >
            {profile?.name ? (
              profile.name.trim().charAt(0).toUpperCase()
            ) : (
              <IconProfileSmall />
            )}
          </button>
          {user.open ? (
            <div className="user-menu" role="menu">
              <div className="user-menu-head">{profile?.name ? `${profile.name}${profile.role ? ` · ${profile.role}` : ""}` : "Not signed in"}</div>
              <hr />
              <button
                className="user-menu-item"
                onClick={() => {
                  user.close();
                  setView("profile");
                }}
              >
                Profile
              </button>
              <button
                className="user-menu-item"
                onClick={() => {
                  user.close();
                  setView("settings");
                }}
              >
                Settings
              </button>
              <button
                className="user-menu-item"
                onClick={() => {
                  user.close();
                  signOut();
                  router.push("/login");
                }}
              >
                Sign out
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}
