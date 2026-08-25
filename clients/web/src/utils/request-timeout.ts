/**
 * Thrown when the surrounding lifecycle aborts a wrapped request. This is
 * distinct from a timeout because the caller cancelled the work.
 */
export class RequestAbortedError extends Error {
  readonly reason: unknown;

  constructor(reason: unknown) {
    super("Request aborted");
    this.name = "RequestAbortedError";
    this.reason = reason;
  }
}

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
  timeoutMs: number;
  signal?: AbortSignal;
  run: (signal: AbortSignal) => Promise<T>;
}

/**
 * Bounds an asynchronous request and forwards cancellation to its transport.
 * The outer lifecycle and timer reject independently because stalled work may
 * never observe its abort signal.
 */
export async function runWithRequestTimeout<T>({
  timeoutMs,
  signal,
  run,
}: RunWithRequestTimeoutArgs<T>): Promise<T> {
  const controller = new AbortController();

  if (signal?.aborted === true) {
    throw new RequestAbortedError(signal.reason);
  }

  let rejectAborted: ((error: RequestAbortedError) => void) | undefined;
  const forwardAbort = () => {
    const error = new RequestAbortedError(signal?.reason);
    // Settle the cancellation race before aborting the transport. A transport
    // may reject synchronously from its abort listener.
    rejectAborted?.(error);
    controller.abort(error);
  };
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectAborted = reject;
  });
  signal?.addEventListener("abort", forwardAbort, { once: true });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new RequestTimeoutError(timeoutMs);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });

  try {
    const running = run(controller.signal);
    return await Promise.race([running, expiry, cancellation]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", forwardAbort);
  }
}
