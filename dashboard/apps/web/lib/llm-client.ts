export type LlmErrorKind =
  | "timeout" // attempt exceeded its deadline — retryable
  | "http" // server answered with an error status
  | "network" // connection-level failure
  | "aborted" // caller cancelled
  | "exhausted"; // retries ran out

/**
 * Error surfaced by the AI paths. `status` distinguishes "not configured"
 * (501, status set) from a transport failure (status undefined), which callers
 * use to decide between an error banner and a local fallback.
 */
export class LlmError extends Error {
  kind: LlmErrorKind;
  attempts: number;
  status?: number;

  constructor(kind: LlmErrorKind, message: string, attempts: number, status?: number) {
    super(message);
    this.name = "LlmError";
    this.kind = kind;
    this.attempts = attempts;
    this.status = status;
  }
}
