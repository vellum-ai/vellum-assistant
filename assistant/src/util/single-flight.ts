/**
 * Per-key single-flight serialization.
 *
 * A {@link createKeyedSingleFlight} instance owns a private chain map. Calling
 * `run(key, fn)` chains `fn` behind any in-flight call for the same `key`, so
 * callers sharing a key execute one at a time, in arrival order (FIFO). Calls
 * with different keys never wait on each other.
 *
 * The chain stores only the tail promise per key — a new caller awaits just the
 * previous tail rather than the whole history — and the entry is deleted once
 * nothing is waiting behind it, keeping the map bounded to the set of keys with
 * work currently in flight.
 */
export interface KeyedSingleFlight {
  <T>(key: string, fn: () => Promise<T>): Promise<T>;
  /**
   * Drop all chain entries. Test-only escape hatch for a clean slate between
   * cases; production code never needs it because entries self-clear once
   * nothing is waiting behind them.
   *
   * @internal
   */
  reset(): void;
}

export function createKeyedSingleFlight(): KeyedSingleFlight {
  const chain = new Map<string, Promise<void>>();

  const run = async function <T>(
    key: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const prior = chain.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Install our tail *before* awaiting so later callers chain behind us.
    chain.set(key, next);
    try {
      await prior;
      return await fn();
    } finally {
      // Only clear the map entry if nothing chained behind us in the meantime.
      if (chain.get(key) === next) {
        chain.delete(key);
      }
      release();
    }
  } as KeyedSingleFlight;

  run.reset = (): void => {
    chain.clear();
  };

  return run;
}
