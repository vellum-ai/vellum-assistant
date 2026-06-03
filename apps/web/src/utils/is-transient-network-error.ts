/**
 * Detects browser-thrown network errors that indicate the fetch request
 * never completed — network drop, DNS timeout, device sleep/wake, tab
 * backgrounded by OS memory pressure.
 *
 * Each browser surfaces the failure differently:
 * - Chrome / Safari: `TypeError: Failed to fetch`
 * - Safari (older): `TypeError: Load failed`
 * - Firefox: `TypeError: NetworkError when attempting to fetch resource`
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

  return false;
}
