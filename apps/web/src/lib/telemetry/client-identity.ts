const STORAGE_KEY = "vellum_client_id";

let cached: string | null = null;

/**
 * Returns a stable per-tab UUID identifying this web client session.
 *
 * Stored in `sessionStorage` so the value:
 *   - Persists across reloads of the same tab (SSE reconnect after refresh
 *     reuses the same id, so the daemon's ClientRegistry keeps tracking it).
 *   - Is unique per browser tab — opening a second tab generates a fresh id.
 *
 * The per-tab granularity matters for ATL-703 self-echo suppression: when a
 * mutation in tab A fires `sync_changed` with `originClientId = A`, only tab
 * A's SSE subscriber should be skipped. Sibling tabs share the same browser
 * profile but need different ids so they still receive the invalidation.
 *
 * History: previously stored in `localStorage` (per-browser-profile). That
 * caused the ClientRegistry to treat sibling tabs as the same client and
 * broke the granularity ATL-703 depends on. The migration is silent — old
 * stored values are ignored; each tab generates a fresh sessionStorage id.
 */
export function getClientId(): string {
  if (cached) return cached;

  if (typeof window !== "undefined" && window.sessionStorage) {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    if (stored) {
      cached = stored;
      return stored;
    }
    const id = crypto.randomUUID();
    sessionStorage.setItem(STORAGE_KEY, id);
    cached = id;
    return id;
  }

  // SSR / non-browser — return a transient id (won't be persisted).
  const id = crypto.randomUUID();
  cached = id;
  return id;
}

/**
 * Headers that identify this web client to the assistant daemon.
 *
 * Attach to:
 *   - Long-lived SSE connections (so the hub's ClientRegistry can track the
 *     subscriber and its interface capabilities).
 *   - **Every** mutating HTTP request (so the daemon route handler can echo
 *     the client id back on the resulting `sync_changed` as `originClientId`,
 *     enabling hub-level self-echo suppression — see ATL-703).
 *
 * The central interceptor at `lib/api-interceptors.ts` attaches these to all
 * generated-client requests; raw `fetch` call sites should still use this
 * helper directly.
 */
export function getClientRegistrationHeaders(): Record<string, string> {
  return {
    "X-Vellum-Client-Id": getClientId(),
    "X-Vellum-Interface-Id": "vellum",
  };
}
