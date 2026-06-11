/**
 * Execute an async operation across many items in bounded-concurrency
 * batches, aborting early if any item throws.
 *
 * Unlike `Promise.allSettled(items.map(fn))` which fires all N
 * requests immediately (blowing rate limits when N is large), this
 * processes at most `batchSize` items in parallel and stops on the
 * first failure — subsequent items are skipped because after a 429
 * every request in the same window will also 429.
 *
 * @param items     The items to process.
 * @param fn        Async operation to run per item.
 * @param batchSize Max items in flight at once (default 10).
 * @returns         Items that were successfully processed.
 */
export async function batchExecute<T>(
  items: readonly T[],
  fn: (item: T) => Promise<void>,
  batchSize = 10,
): Promise<{ succeeded: number; abortedAt: number | null }> {
  let succeeded = 0;

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const results = await Promise.allSettled(batch.map(fn));

    let batchFailed = false;
    for (const result of results) {
      if (result.status === "fulfilled") {
        succeeded++;
      } else {
        batchFailed = true;
      }
    }

    if (batchFailed) {
      return { succeeded, abortedAt: i };
    }
  }

  return { succeeded, abortedAt: null };
}
