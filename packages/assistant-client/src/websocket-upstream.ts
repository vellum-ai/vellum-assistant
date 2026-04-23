/**
 * WebSocket upstream URL and auth helpers for gateway-to-assistant
 * WebSocket connections.
 *
 * Used by browser-relay, twilio relay/media, and STT stream routes to
 * construct authenticated upstream WebSocket URLs to the assistant runtime.
 */

// ---------------------------------------------------------------------------
// Protocol conversion
// ---------------------------------------------------------------------------

/**
 * Convert an HTTP(S) base URL to a WS(S) URL. Replaces the leading
 * `http` with `ws` (preserving `s` for TLS).
 */
export function httpToWs(httpBaseUrl: string): string {
  return httpBaseUrl.replace(/^http/, "ws");
}

// ---------------------------------------------------------------------------
// Upstream URL construction
// ---------------------------------------------------------------------------

export type WsUpstreamOptions = {
  /** HTTP base URL of the assistant runtime (e.g. `http://localhost:7821`). */
  baseUrl: string;
  /** Path on the upstream WS server (e.g. `/v1/browser-relay`). */
  path: string;
  /** Service token injected as the `token` query parameter. */
  serviceToken: string;
  /**
   * Additional query parameters to forward to the upstream. The `token`
   * param is always set from `serviceToken` and should not be included
   * here.
   */
  extraParams?: Record<string, string>;
};

export type WsUpstreamResult = {
  /** Full upstream WebSocket URL with auth token and extra params. */
  url: string;
  /** A version of the URL with the token value replaced by `<redacted>`. */
  logSafeUrl: string;
};

/**
 * Build an authenticated upstream WebSocket URL for the assistant runtime.
 *
 * The service token is always injected as the `token` query parameter
 * (browser WebSocket upgrades cannot set custom headers, so query-param
 * auth is the standard mechanism across all WS routes).
 *
 * Returns both the real URL and a log-safe variant with the token redacted.
 */
export function buildWsUpstreamUrl(opts: WsUpstreamOptions): WsUpstreamResult {
  const wsBase = httpToWs(opts.baseUrl.replace(/\/+$/, ""));
  const normalizedPath = opts.path.startsWith("/")
    ? opts.path
    : `/${opts.path}`;

  const query = new URLSearchParams({ token: opts.serviceToken });
  if (opts.extraParams) {
    for (const [key, value] of Object.entries(opts.extraParams)) {
      if (key !== "token") {
        query.set(key, value);
      }
    }
  }

  const url = `${wsBase}${normalizedPath}?${query.toString()}`;

  // Build log-safe URL by replacing the token value
  const logQuery = new URLSearchParams(query);
  logQuery.set("token", "<redacted>");
  const logSafeUrl = `${wsBase}${normalizedPath}?${logQuery.toString()}`;

  return { url, logSafeUrl };
}
