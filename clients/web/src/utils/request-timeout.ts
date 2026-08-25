/**
 * Client-side upper bound for a single in-flight request.
 *
 * A fetch that is never dispatched, or whose response never arrives, leaves
 * TanStack Query in `pending` forever, and any UI keyed off `isPending`
 * renders its loading state with no terminal outcome. Racing the request
 * against a timer guarantees the query settles: the caller either gets the
 * response or a `RequestTimeoutError`.
 *
 * The runner also aborts the request it wraps, so the transport stops work
 * that no consumer is waiting for. Aborting alone is not enough to bound the
 * lifecycle: a request stalled before dispatch may never observe its signal,
 * which is why the timer rejects independently.
 *
 * References:
 * - TanStack Query cancellation: https://tanstack.com/query/latest/docs/framework/react/guides/query-cancellation
 * - AbortSignal: https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal
 */

/** Thrown when a wrapped request outlives its client-side bound. */
export class RequestTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Request timed out after ${timeoutMs}ms`);
    this.name = "RequestTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

interface RunWithRequestTimeoutArgs<T> {
  /** Bound, in milliseconds, for the whole `run` call. */
  timeoutMs: number;
  /**
   * Signal of the surrounding lifecycle (TanStack Query's `queryFn` signal).
   * Its abort is forwarded to `run`.
   */
  signal?: AbortSignal;
  /** Issues the request with the signal it must honor. */
  run: (signal: AbortSignal) => Promise<T>;
}

export async function runWithRequestTimeout<T>({
  timeoutMs,
  signal,
  run,
}: RunWithRequestTimeoutArgs<T>): Promise<T> {
  const controller = new AbortController();
  const forwardAbort = () => {
    controller.abort(signal?.reason);
  };
  if (signal?.aborted === true) {
    forwardAbort();
  } else {
    signal?.addEventListener("abort", forwardAbort, { once: true });
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new RequestTimeoutError(timeoutMs);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });

  const running = run(controller.signal);
  // The loser of the race still settles; swallow its rejection so a request
  // that rejects after the timeout does not surface as unhandled.
  running.catch(() => {});

  try {
    return await Promise.race([running, expiry]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", forwardAbort);
  }
}
