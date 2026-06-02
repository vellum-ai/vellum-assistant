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
 * These are transient conditions, not application bugs.
 *
 * Reference: https://developer.mozilla.org/en-US/docs/Web/API/Window/fetch#exceptions
 */
export function isTransientNetworkError(error: unknown): boolean {
  return (
    error instanceof TypeError &&
    /^(failed to fetch|load failed|networkerror when attempting to fetch resource)\.?$/i.test(
      error.message,
    )
  );
}
