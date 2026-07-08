import {
  CLIENT_METADATA_HEADERS,
  sanitizeClientMetadataValue,
} from "@vellumai/service-contracts/client-metadata";

import {
  detectBrowserInfo,
  detectClientOs,
} from "@/runtime/platform-detection";

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

let cachedMetadataHeaders: Record<string, string> | null = null;

/**
 * Sanitized client-metadata headers persisted by the daemon under
 * `metadata.client` for turn analytics. All inputs (browser, OS surface,
 * build version) are constant for the lifetime of the page, so the result
 * is computed once and cached in module memory.
 *
 * These are analytics-only: unlike `X-Vellum-Interface-Id`, none of them
 * feed subscriber capability resolution.
 */
function getClientMetadataHeaders(): Record<string, string> {
  if (cachedMetadataHeaders) {
    return cachedMetadataHeaders;
  }
  const browser = detectBrowserInfo();
  const candidates: Array<[string, string | undefined]> = [
    [CLIENT_METADATA_HEADERS.browser_family, browser.family],
    [CLIENT_METADATA_HEADERS.browser_version, browser.version],
    [CLIENT_METADATA_HEADERS.os, detectClientOs()],
    [
      CLIENT_METADATA_HEADERS.interface_version,
      import.meta.env.VITE_APP_VERSION,
    ],
  ];
  const headers: Record<string, string> = {};
  for (const [name, raw] of candidates) {
    const value = sanitizeClientMetadataValue(raw);
    if (value) {
      headers[name] = value;
    }
  }
  cachedMetadataHeaders = headers;
  return headers;
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
    // Always "web" — do NOT derive this from the runtime platform.
    //
    // The daemon derives an SSE subscriber's host-proxy capabilities purely
    // from this registration interface id (`events-routes.ts` →
    // `supportsHostProxy`), and "macos" grants all host_* capabilities. The
    // web bundle is never a host-proxy provider: on the desktop app the
    // Electron *main* process opens its own SSE registered as "macos" (with
    // the device id) to serve host tools. If this renderer connection also
    // reported "macos", there would be two same-user "macos" clients
    // advertising host capabilities, and host-tool auto-resolution would
    // fail as ambiguous (`pickSameUserAutoResolve`). Platform awareness for
    // the assistant flows through the message body's `clientOs` field instead
    // (see `detectClientOs` in `domains/chat/api/messages.ts`), which only
    // feeds the per-turn `client_os` context and has no bearing on subscriber
    // capabilities.
    "X-Vellum-Interface-Id": "web",
    // Analytics-only client metadata (browser family/version, OS surface,
    // build version), persisted under `metadata.client` on user messages.
    // Values are sanitized and bounded; none affect capability resolution.
    ...getClientMetadataHeaders(),
  };
}
