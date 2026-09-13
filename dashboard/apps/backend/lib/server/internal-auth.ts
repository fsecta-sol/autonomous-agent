/**
 * Gate for the internal tool endpoints the agent service calls back into.
 * These are not user-facing: they require the shared secret the agent holds,
 * and are never reachable from the browser (which has no such token).
 */
const INTERNAL_TOOL_TOKEN = process.env.INTERNAL_TOOL_TOKEN || "";

/**
 * Returns a 401 response when the request lacks the shared token, else null
 * (meaning: proceed). When no token is configured the endpoints are disabled
 * outright, so a misconfigured deployment never exposes them unauthenticated.
 */
export function requireInternal(request: Request): Response | null {
  if (!INTERNAL_TOOL_TOKEN) {
    return Response.json({ error: "Internal tools are not configured" }, { status: 503 });
  }
  const header = request.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (token !== INTERNAL_TOOL_TOKEN) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}
