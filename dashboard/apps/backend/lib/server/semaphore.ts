/**
 * In-process concurrency limiter for upstream LLM calls.
 *
 * A single Node process serves every request, so a bounded counter is enough to
 * stop N open tabs from slamming the provider and exhausting the connection
 * pool. It is deliberately per-process, not distributed — that is the right
 * scope until there is more than one instance.
 */
class Semaphore {
  private limit: number;
  private active = 0;
  private queue: Array<() => void> = [];

  constructor(limit: number) {
    this.limit = Math.max(1, limit);
  }

  /**
   * Acquire a slot, waiting up to `deadlineMs`. Resolves `false` if the deadline
   * elapses first — the caller then returns 503 rather than hanging.
   */
  acquire(deadlineMs: number): Promise<boolean> {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const grant = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // slot is transferred from the releaser — `active` is unchanged
        resolve(true);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const i = this.queue.indexOf(grant);
        if (i >= 0) this.queue.splice(i, 1);
        resolve(false);
      }, deadlineMs);
      this.queue.push(grant);
    });
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
      return;
    }
    this.active = Math.max(0, this.active - 1);
  }
}

let instance: Semaphore | null = null;
let instanceLimit = -1;

export function getSemaphore(limit: number): Semaphore {
  if (!instance || instanceLimit !== limit) {
    instance = new Semaphore(limit);
    instanceLimit = limit;
  }
  return instance;
}
