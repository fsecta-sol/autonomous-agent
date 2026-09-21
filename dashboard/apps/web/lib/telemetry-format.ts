/**
 * Pure formatters for the agent console's telemetry surface. Kept out of the
 * component so the same reading (a heartbeat age, a latency, an uptime) is
 * rendered identically everywhere it appears.
 */

/** A live-reading age: "1.8s" / "42s" / "3m" / "1.2h" / "2d". "—" when never. */
export function formatAge(ms: number | null): string {
  if (ms === null) return "—";
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Uptime: "42m" / "3h 42m" / "2d 4h". "—" under a minute. */
export function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return "—";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return rm ? `${h}h ${rm}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d}d ${rh}h` : `${d}d`;
}

/** A latency reading: "420ms" under a second, else "4.8s". "—" when null. */
export function formatLatency(ms: number | null): string {
  if (ms === null) return "—";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** An error rate: "1.2%". "—" when there is no history to measure. */
export function formatRate(rate: number | null): string {
  return rate === null ? "—" : `${(rate * 100).toFixed(1)}%`;
}
