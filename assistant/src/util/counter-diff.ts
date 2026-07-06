/**
 * Per-key difference between two snapshots of the same counter object. Used to
 * turn cumulative since-boot kernel counters (memory.stat, memory.events,
 * cpu.stat) into per-window deltas. A key is null in the result when either
 * side lacks it; the whole result is null when either snapshot is missing.
 */
export function diffCounters<T extends Record<keyof T & string, number | null>>(
  prev: T | null,
  current: T | null,
): T | null {
  if (prev == null || current == null) {
    return null;
  }
  const out: Record<string, number | null> = {};
  for (const key of Object.keys(current) as Array<keyof T & string>) {
    const before = prev[key];
    const after = current[key];
    out[key] = before != null && after != null ? after - before : null;
  }
  return out as T;
}
