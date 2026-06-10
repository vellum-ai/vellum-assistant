/**
 * Creates a concurrency-limited wrapper around an async function.
 *
 * Calls beyond the concurrency limit are dropped (not queued) —
 * appropriate for fire-and-forget cache-refresh patterns where a
 * stale request is worse than a skipped one: the next sync_changed
 * event will retry, and the trailing-edge list refetch is the
 * authoritative reconciliation.
 */
export function createConcurrencyLimiter<Args extends unknown[]>(
  fn: (...args: Args) => Promise<void>,
  limit: number,
): (...args: Args) => Promise<void> {
  let active = 0;

  return async (...args: Args): Promise<void> => {
    if (active >= limit) return;
    active++;
    try {
      await fn(...args);
    } finally {
      active--;
    }
  };
}
