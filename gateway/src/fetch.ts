/**
 * Thin wrapper around globalThis.fetch exposed through a module boundary.
 * On some platforms (Bun 1.3.9 on Linux) replacing globalThis.fetch at
 * runtime does not reliably intercept outgoing requests.  Importing fetch
 * via this module allows tests to use mock.module() for deterministic,
 * cross-platform interception.
 */
/**
 * Request options plus the runtime's own extensions.
 *
 * `timeout` is not part of the Fetch standard. The runtime applies a 300-second
 * default to every request and, critically, an `AbortSignal` supplied by the
 * caller does NOT extend it — a request carrying a 60-minute abort deadline
 * still dies at 300 seconds with `TimeoutError`. Setting `timeout: false` hands
 * deadline control back to the caller's signal.
 */
export interface FetchInit extends RequestInit {
  timeout?: boolean | number;
}

export function fetchImpl(
  input: string | URL | Request,
  init?: FetchInit,
): Promise<Response> {
  return globalThis.fetch(input, init);
}
