let cached: string | null = null;

/**
 * Returns a UUID identifying this page load.
 *
 * Generated on first call, cached in module memory for the rest of the
 * page's lifetime. Not persisted anywhere — each page load (initial nav,
 * reload, duplicated tab, restored bfcache entry) produces a fresh id.
 *
 * This is the unit the assistant daemon's self-echo suppression keys off:
 * a mutation and the SSE subscriber that should be skipped both come from
 * the same page-load `getClientId()` call, so they always match. Two tabs
 * (or duplicates of one) never collide because each got its own module
 * initialization.
 */
export function getClientId(): string {
  if (cached) return cached;
  cached = crypto.randomUUID();
  return cached;
}

/**
 * Headers identifying this web client to the assistant daemon.
 *
 * Attach to:
 *   - Long-lived SSE connections (so the hub's ClientRegistry can track
 *     the subscriber and its interface capabilities).
 *   - Every HTTP request (so the daemon can echo the id back on the
 *     resulting `sync_changed` and the hub can skip the originator's SSE
 *     subscriber).
 *
 * The central interceptor at `lib/api-interceptors.ts` attaches these to
 * all generated-client requests; raw `fetch` call sites still call this
 * helper directly.
 */
export function getClientRegistrationHeaders(): Record<string, string> {
  return {
    "X-Vellum-Client-Id": getClientId(),
    "X-Vellum-Interface-Id": "vellum",
  };
}
