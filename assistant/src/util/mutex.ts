/**
 * Async mutex for serializing access to a shared resource.
 *
 * Callers wait in FIFO order. `withLock(fn)` is the primary API —
 * it acquires the lock, runs `fn`, and releases the lock when `fn`
 * settles (even on throw).
 *
 * Used by git-service (per-workspace repo operations) and
 * conversation-title-service (serial LLM calls) to prevent
 * concurrent access to resources that cannot safely overlap.
 */
export class Mutex {
  private locked = false;
  private waitQueue: Array<() => void> = [];

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waitQueue.push(resolve);
    });
  }

  release(): void {
    const next = this.waitQueue.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }

  /**
   * Execute `fn` while holding the lock.
   * Automatically releases the lock when done, even if `fn` throws.
   */
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
