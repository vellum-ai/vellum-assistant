/**
 * Map `fn` over `items` with bounded concurrency, preserving input order in the
 * result array. At most `limit` invocations of `fn` are in flight at once.
 *
 * Each of the `min(limit, items.length)` workers pulls the next index off a
 * shared cursor and processes it, so faster items don't block on slower ones.
 * Results are written back to their original positions, so `out[i]` always
 * corresponds to `items[i]` regardless of completion order.
 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (t: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}
