/**
 * Per-key async mutex built on Promise chaining.
 *
 * Operations submitted for the SAME key run strictly one-at-a-time in
 * submission order; operations for DIFFERENT keys proceed concurrently. This
 * is the lightweight in-process serialization primitive used to guard shared
 * mutable resources (e.g. an app's source dir + its dist/ rebuild) against
 * concurrent callers racing on `rm -rf` + write sequences, per the
 * "serialise per-resource" rule in CLAUDE.md.
 *
 * The same pattern already backs `createSurfaceMutex`; this generalises it as a
 * standalone utility so other per-resource critical sections can reuse it.
 */
export type KeyedMutex = {
  /**
   * Run `fn` exclusively with respect to other `run` calls sharing `key`.
   * Returns whatever `fn` resolves to (or rejects with `fn`'s error). A
   * rejection does not poison the queue — subsequent operations still run.
   */
  <T>(key: string, fn: () => T | Promise<T>): Promise<T>;
  /** Number of keys with an in-flight or queued operation (for tests). */
  readonly size: number;
};

export function createKeyedMutex(): KeyedMutex {
  const chains = new Map<string, Promise<unknown>>();

  const mutex = <T>(key: string, fn: () => T | Promise<T>): Promise<T> => {
    const prev = chains.get(key) ?? Promise.resolve();
    // Chain off the prior op regardless of its outcome so a failure doesn't
    // block the queue, but only start `fn` after the prior op fully settles.
    const next = prev.then(fn, fn);
    // The tail keeps the chain alive and swallows errors so the map entry
    // stays a clean "previous settled" anchor for the next submission.
    const tail = next.then(
      () => {},
      () => {},
    );
    chains.set(key, tail);
    // Drop the entry once the queue drains to keep the map bounded.
    tail.then(() => {
      if (chains.get(key) === tail) {
        chains.delete(key);
      }
    });
    return next;
  };

  Object.defineProperty(mutex, "size", { get: () => chains.size });
  return mutex as KeyedMutex;
}
