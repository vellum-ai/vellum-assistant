/**
 * Single-key debouncer. Delays execution until no new calls arrive
 * within the specified delay period.
 */
/**
 * Multi-key debouncer. Each key gets its own independent timer.
 * Includes an optional entry limit with eviction of oldest non-protected entries.
 */
export class DebouncerMap {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly defaultDelayMs: number;
  private readonly maxEntries: number;
  private readonly protectedKeyPrefix: string;

  constructor(options: {
    defaultDelayMs: number;
    maxEntries?: number;
    protectedKeyPrefix?: string;
  }) {
    this.defaultDelayMs = options.defaultDelayMs;
    this.maxEntries = options.maxEntries ?? Infinity;
    this.protectedKeyPrefix = options.protectedKeyPrefix ?? "";
  }

  schedule(key: string, fn: () => void, delayMs?: number): void {
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(key);
      fn();
    }, delayMs ?? this.defaultDelayMs);
    this.timers.set(key, timer);
    this.enforceLimit();
  }

  cancel(key: string): void {
    const timer = this.timers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
  }

  cancelAll(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  get size(): number {
    return this.timers.size;
  }

  private enforceLimit(): void {
    if (this.timers.size <= this.maxEntries) return;
    const excess = this.timers.size - this.maxEntries;
    let removed = 0;
    for (const [key, timer] of this.timers) {
      if (removed >= excess) break;
      if (this.protectedKeyPrefix && key.startsWith(this.protectedKeyPrefix))
        continue;
      clearTimeout(timer);
      this.timers.delete(key);
      removed++;
    }
  }
}
