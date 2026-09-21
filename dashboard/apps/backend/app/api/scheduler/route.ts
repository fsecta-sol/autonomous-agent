import { NextRequest } from "next/server";
import { requireOperator } from "@/lib/server/auth";

export const dynamic = "force-dynamic";

const AGENT_URL = (process.env.AGENT_URL || "http://127.0.0.1:8012").replace(/\/+$/, "");

/**
 * Scheduler collection.
 *   GET  — one merged overview: the debug view (workers, queue, upcoming,
 *          running, waiting, retrying, dead-letter, resources, metrics), every
 *          schedule, the job list, and the pluggable registries. `enabled:false`
 *          when the agent has the scheduler disabled (HTTP 503 upstream).
 *   POST — create a durable schedule for an existing research run.
 */
export async function GET() {
  const gate = await requireOperator();
  if (gate instanceof Response) return gate;
  try {
    const [debug, schedules, jobs, registries] = await Promise.all([
      fetch(`${AGENT_URL}/scheduler/debug`, { cache: "no-store" }),
      fetch(`${AGENT_URL}/scheduler/schedules`, { cache: "no-store" }),
      fetch(`${AGENT_URL}/scheduler/jobs?limit=200`, { cache: "no-store" }),
      fetch(`${AGENT_URL}/scheduler/registries`, { cache: "no-store" }),
    ]);
    // The agent answers 503 ("scheduler is disabled") when the scheduler is off;
    // surface that as a first-class disabled state rather than an error.
    if (debug.status === 503) return Response.json({ enabled: false });
    if (!debug.ok) return Response.json({ error: `Agent service HTTP ${debug.status}` }, { status: 502 });
    const [d, s, j, r] = (await Promise.all([
      debug.json(),
      schedules.ok ? schedules.json() : {},
      jobs.ok ? jobs.json() : {},
      registries.ok ? registries.json() : {},
    ])) as [Record<string, unknown>, Record<string, unknown>, Record<string, unknown>, Record<string, unknown>];
    return Response.json({
      enabled: true,
      debug: d.scheduler ?? null,
      schedules: s.schedules ?? [],
      jobs: j.jobs ?? [],
      registries: r,
    });
  } catch (err) {
    return Response.json({ error: "Agent service unavailable", detail: String(err) }, { status: 502 });
  }
}

/** Create a schedule. Only an existing research run can be scheduled. */
export async function POST(request: NextRequest) {
  const gate = await requireOperator();
  if (gate instanceof Response) return gate;
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Malformed JSON body" }, { status: 400 });
  }
  const researchRunId = typeof body.researchRunId === "string" ? body.researchRunId.trim() : "";
  if (!researchRunId) return Response.json({ error: "researchRunId is required" }, { status: 400 });
  const type = typeof body.type === "string" ? body.type : "IMMEDIATE";

  const payload: Record<string, unknown> = {
    research_run_id: researchRunId,
    type,
    priority: typeof body.priority === "string" ? body.priority : "NORMAL",
    created_by: "USER",
  };
  if (typeof body.cron === "string") payload.cron = body.cron;
  if (typeof body.intervalS === "number") payload.interval_s = body.intervalS;
  if (typeof body.delayS === "number") payload.delay_s = body.delayS;
  if (typeof body.at === "string" && body.at) payload.at = body.at;
  if (typeof body.event === "string") payload.event = body.event;
  if (typeof body.timezone === "string" && body.timezone) payload.timezone = body.timezone;
  if (typeof body.maxRuns === "number") payload.max_runs = body.maxRuns;
  if (Array.isArray(body.dependsOn)) payload.depends_on = body.dependsOn;

  try {
    const res = await fetch(`${AGENT_URL}/scheduler/schedules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    return Response.json(data, { status: res.status });
  } catch (err) {
    return Response.json({ error: "Agent service unavailable", detail: String(err) }, { status: 502 });
  }
}
