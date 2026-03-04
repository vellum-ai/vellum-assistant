/**
 * Semaphore-based concurrency limiter for parallel segment processing.
 *
 * Limits how many async operations can run simultaneously to avoid
 * overwhelming API rate limits or exhausting system resources.
 */

export class ConcurrencyPool {
  private running = 0;
  private queue: Array<() => void> = [];

  constructor(private readonly maxConcurrency: number = 10) {
    if (maxConcurrency < 1) {
      throw new Error("maxConcurrency must be at least 1");
    }
  }

  /**
   * Acquire a slot in the pool. Resolves immediately if a slot is available,
   * otherwise waits until one is freed via `release()`.
   */
  acquire(): Promise<void> {
    if (this.running < this.maxConcurrency) {
      this.running++;
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  /**
   * Release a slot back to the pool, allowing the next queued caller to proceed.
   */
  release(): void {
    const next = this.queue.shift();
    if (next) {
      // Hand the slot directly to the next waiter (running count stays the same)
      next();
    } else if (this.running > 0) {
      this.running--;
    }
  }

  /** Number of slots currently in use. */
  get activeCount(): number {
    return this.running;
  }

  /** Number of callers waiting for a slot. */
  get waitingCount(): number {
    return this.queue.length;
  }
}
