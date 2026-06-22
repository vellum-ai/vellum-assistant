/**
 * Snapshot the given env vars now; returns a restore function suitable for
 * `afterEach` that resets each var to its captured value (or deletes it).
 */
export function snapshotEnv(keys: readonly string[]): () => void {
  const saved: Record<string, string | undefined> = {};
  for (const key of keys) {
    saved[key] = process.env[key];
  }
  return () => {
    for (const key of keys) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  };
}
