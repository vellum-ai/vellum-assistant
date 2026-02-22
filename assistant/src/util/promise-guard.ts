/**
 * Guards against concurrent execution of an async factory.
 * Multiple concurrent callers share the same in-flight promise.
 * On failure, the guard resets so subsequent calls can retry.
 */
export class PromiseGuard<T> {
  private promise: Promise<T> | null = null;

  /** Whether a promise is currently in-flight. */
  get active(): boolean {
    return this.promise !== null;
  }

  /**
   * Execute the factory, deduplicating concurrent calls.
   * If a call is already in-flight, returns the same promise.
   * On failure, clears the cached promise to allow retry.
   *
   * @param factory - Creates the promise on first call.
   * @param onError - Optional callback invoked when the factory rejects (before re-throwing).
   */
  run(factory: () => Promise<T>, onError?: (err: unknown) => void): Promise<T> {
    if (this.promise) return this.promise;

    this.promise = factory();
    this.promise.catch((err) => {
      this.promise = null;
      onError?.(err);
    });
    return this.promise;
  }

  /** Reset the guard, allowing the next call to create a new promise. */
  reset(): void {
    this.promise = null;
  }
}
