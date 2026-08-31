/**
 * Single-flight async initializer whose failures are not cached.
 *
 * Concurrent callers share one in-flight load, a resolved value is cached
 * for the lifetime of the module, and a rejection clears the slot so the
 * next call retries. Retrying is the caller's move (call `load()` again);
 * nothing here schedules one, so a persistent failure cannot loop.
 */
export interface AsyncOnce<T> {
  /**
   * The resolved value, or null while unloaded, in flight, or after a
   * failure. Lets synchronous readers (e.g. a useState initializer under
   * renderToStaticMarkup, where effects never run) pick up a warm cache.
   */
  peek(): T | null;
  /** Starts or joins the single-flight load. */
  load(): Promise<T>;
}

export function asyncOnce<T>(load: () => Promise<T>): AsyncOnce<T> {
  let value: T | null = null;
  let inFlight: Promise<T> | null = null;
  return {
    peek: () => value,
    load: () => {
      inFlight ??= load().then(
        (loaded) => {
          value = loaded;
          return loaded;
        },
        (error: unknown) => {
          inFlight = null;
          throw error;
        },
      );
      return inFlight;
    },
  };
}
