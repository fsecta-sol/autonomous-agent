"use client";

import { useSyncExternalStore } from "react";

/**
 * Client-only state (theme, auth flag, operator profile) backed by
 * localStorage and read through useSyncExternalStore. This keeps reads out of
 * render-phase effects and gives React a hydration-safe server snapshot.
 */

type Listener = () => void;
const listeners = new Set<Listener>();

function subscribe(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function emit(): void {
  for (const l of listeners) l();
}

// parsed-JSON cache so getSnapshot returns a stable reference between writes
const jsonCache = new Map<string, { raw: string | null; value: unknown }>();

function rawGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function readFlag(key: string): boolean {
  return rawGet(key) === "1";
}

export function writeFlag(key: string, on: boolean): void {
  try {
    if (on) localStorage.setItem(key, "1");
    else localStorage.removeItem(key);
  } catch {
    /* storage unavailable */
  }
  emit();
}

export function readJSON<T>(key: string, fallback: T): T {
  const raw = rawGet(key);
  const hit = jsonCache.get(key);
  if (hit && hit.raw === raw) return hit.value as T;
  let value: T = fallback;
  if (raw != null) {
    try {
      value = JSON.parse(raw) as T;
    } catch {
      value = fallback;
    }
  }
  jsonCache.set(key, { raw, value });
  return value;
}

export function writeJSON<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
  emit();
}

/** true once the client has hydrated; false for the server render */
export function useHydrated(): boolean {
  return useSyncExternalStore(subscribe, () => true, () => false);
}

export function useFlag(key: string): boolean {
  return useSyncExternalStore(subscribe, () => readFlag(key), () => false);
}

export function useJSON<T>(key: string, fallback: T): T {
  // fallback must be referentially stable — pass module constants (e.g. null)
  return useSyncExternalStore(subscribe, () => readJSON(key, fallback), () => fallback);
}

export function useStoredString(key: string, fallback: string): string {
  return useSyncExternalStore(subscribe, () => rawGet(key) ?? fallback, () => fallback);
}

/** Re-renders when a media query's match state changes; false on the server. */
export function useMediaQuery(query: string): boolean {
  const subscribeMq = (cb: () => void) => {
    const mq = window.matchMedia(query);
    mq.addEventListener("change", cb);
    return () => mq.removeEventListener("change", cb);
  };
  return useSyncExternalStore(
    subscribeMq,
    () => window.matchMedia(query).matches,
    () => false,
  );
}
