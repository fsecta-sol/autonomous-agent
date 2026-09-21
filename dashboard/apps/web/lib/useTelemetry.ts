"use client";

import { useEffect, useRef, useState } from "react";
import { fetchTelemetry } from "@/lib/api";
import type { SwarmTelemetry } from "@dashboard/shared";

/** How often to poll the telemetry feed while the tab is visible. */
const POLL_MS = 2000;
/** Consecutive failures before the feed is declared offline. */
const OFFLINE_AFTER = 2;

export interface TelemetryFeed {
  /** the latest snapshot, or null before the first successful poll */
  data: SwarmTelemetry | null;
  /** epoch ms of the last successful poll (drives "cloud client" freshness) */
  seenAt: number | null;
  /** true once polling has failed enough times to be considered down */
  offline: boolean;
}

/**
 * Polls the swarm's derived telemetry. It pauses while the tab is hidden (no
 * point spending requests on a background tab) and resumes on return, and it
 * tracks a consecutive-failure count so the UI can honestly read "offline"
 * rather than showing a stale snapshot as if it were live.
 */
export function useTelemetry(): TelemetryFeed {
  const [data, setData] = useState<SwarmTelemetry | null>(null);
  const [seenAt, setSeenAt] = useState<number | null>(null);
  const [offline, setOffline] = useState(false);
  const failsRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (cancelled) return;
      // Don't poll a hidden tab; the visibilitychange listener restarts us.
      if (document.visibilityState === "hidden") return schedule(POLL_MS);
      try {
        const snap = await fetchTelemetry();
        if (cancelled) return;
        failsRef.current = 0;
        setData(snap);
        setSeenAt(Date.now());
        setOffline(false);
      } catch {
        if (cancelled) return;
        failsRef.current += 1;
        if (failsRef.current >= OFFLINE_AFTER) setOffline(true);
      }
      schedule(POLL_MS);
    };

    const schedule = (ms: number) => {
      if (cancelled) return;
      timer = setTimeout(tick, ms);
    };

    const onVisible = () => {
      if (document.visibilityState === "visible") {
        if (timer) clearTimeout(timer);
        void tick();
      }
    };

    void tick();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return { data, seenAt, offline };
}
