"use client";

import { createContext, useCallback, useContext, useEffect, useSyncExternalStore, type ReactNode } from "react";

export type ThemeMode = "light" | "dark";

interface ThemeValue {
  theme: ThemeMode;
  toggle: () => void;
  setTheme: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeValue | null>(null);

const THEME_KEY = "agent-theme";
const themeListeners = new Set<() => void>();

function subscribeTheme(cb: () => void): () => void {
  themeListeners.add(cb);
  return () => {
    themeListeners.delete(cb);
  };
}

/** the DOM attribute is the source of truth — the boot script sets it pre-paint */
function getTheme(): ThemeMode {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

/** a stored preference that is a real choice — the OS must not override it */
function hasStoredChoice(): boolean {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return stored === "dark" || stored === "light";
  } catch {
    return false;
  }
}

function applyTheme(mode: ThemeMode, persist = true) {
  document.documentElement.setAttribute("data-theme", mode);
  if (persist) {
    try {
      localStorage.setItem(THEME_KEY, mode);
    } catch {
      /* storage unavailable — theme still applies for this session */
    }
  }
  for (const l of themeListeners) l();
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const theme = useSyncExternalStore<ThemeMode>(subscribeTheme, getTheme, () => "light");

  const setTheme = useCallback((mode: ThemeMode) => applyTheme(mode), []);
  const toggle = useCallback(() => applyTheme(getTheme() === "light" ? "dark" : "light"), []);

  useEffect(() => {
    let mq: MediaQueryList;
    try {
      mq = window.matchMedia("(prefers-color-scheme: dark)");
    } catch {
      return;
    }
    const onSystemChange = (e: MediaQueryListEvent) => {
      // An explicit toggle keeps winning and stays persisted; only follow the OS
      // while no stored choice exists.
      if (!hasStoredChoice()) applyTheme(e.matches ? "dark" : "light", false);
    };
    mq.addEventListener("change", onSystemChange);
    return () => mq.removeEventListener("change", onSystemChange);
  }, []);

  return <ThemeContext.Provider value={{ theme, toggle, setTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
