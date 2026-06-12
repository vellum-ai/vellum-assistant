/**
 * Detects browser-thrown network errors that indicate a fetch request
 * failed or a response body stream was interrupted by a network event
 * (connection drop, DNS timeout, device sleep/wake, proxy idle close,
 * tab backgrounded by OS memory pressure).
 *
 * Browsers surface the failure differently depending on WHEN in the
 * fetch lifecycle it occurs:
 *
 * Initial fetch (before response body):
 * - Chrome / Safari: `TypeError: Failed to fetch`
 * - Safari (older): `TypeError: Load failed`
 * - Firefox: `TypeError: NetworkError when attempting to fetch resource`
 *
 * Mid-stream body read (after HTTP 200, during ReadableStream consumption):
 * - Chrome: `TypeError: network error`
 * - Firefox: `TypeError: Error in input stream`
 * - Safari: `TypeError: Load failed` (same as initial — already covered)
 *
 * Middleware that wraps `window.fetch` (e.g. the Sentry SDK's fetch
 * instrumentation) may append a hostname suffix to the message before
 * application code sees it — e.g. `"Failed to fetch (example.com)"`.
 * We configure the Sentry SDK to avoid this (`enhanceFetchErrorMessages:
 * 'report-only'`), but as defense-in-depth the detection here tolerates
 * an optional trailing `(hostname)` suffix.
 *
 * Pattern follows `is-network-error` (14 M weekly downloads):
 * https://github.com/sindresorhus/is-network-error/blob/main/index.js
 *
 * Reference: https://developer.mozilla.org/en-US/docs/Web/API/Window/fetch#exceptions
 * Reference: https://fetch.spec.whatwg.org/#concept-network-error
 * Reference: https://github.com/whatwg/fetch/issues/676 (mid-stream TypeError behavior)
 */
export function isTransientNetworkError(error: unknown): boolean {
  if (!(error instanceof TypeError)) return false;

  const msg = error.message;

  // Chrome / Safari: exact or with hostname suffix from fetch middleware.
  if (
    msg === "Failed to fetch" ||
    (msg.startsWith("Failed to fetch (") && msg.endsWith(")"))
  ) {
    return true;
  }

  // Safari (older): exact or with hostname suffix.
  if (
    msg === "Load failed" ||
    (msg.startsWith("Load failed (") && msg.endsWith(")"))
  ) {
    return true;
  }

  // Firefox (with or without trailing dot).
  if (
    msg === "NetworkError when attempting to fetch resource" ||
    msg === "NetworkError when attempting to fetch resource."
  ) {
    return true;
  }

  // --- Mid-stream body read errors (after HTTP 200, during ReadableStream) ---

  // Chrome: thrown by reader.read() when the underlying TCP connection drops.
  if (msg === "network error") {
    return true;
  }

  // Firefox: thrown by TextDecoderStream/reader.read() on stream interruption.
  if (msg === "Error in input stream") {
    return true;
  }

  return false;
}
