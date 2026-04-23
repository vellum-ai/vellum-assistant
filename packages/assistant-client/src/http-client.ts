/**
 * Reusable HTTP request helpers for gateway-to-assistant-runtime communication.
 *
 * Provides upstream URL construction, service-token auth header injection,
 * timeout handling, and hop-by-hop header stripping. These primitives are
 * consumed by proxy-forward (control-plane proxying) and directly by
 * gateway routes that need non-proxy HTTP calls to the runtime.
 */

// ---------------------------------------------------------------------------
// Hop-by-hop header stripping
// ---------------------------------------------------------------------------

/**
 * Headers that must be removed when proxying between hops (RFC 2616 / 7230).
 * The `Connection` header value is also consulted for additional names.
 */
const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

/**
 * Strip hop-by-hop headers from a `Headers` instance.
 *
 * Also removes any additional header names referenced in the `Connection`
 * header value (per RFC 7230 section 6.1). Returns a new `Headers` instance;
 * the input is not mutated.
 */
export function stripHopByHop(headers: Headers): Headers {
  const cleaned = new Headers(headers);

  const connectionValue = cleaned.get("connection");
  if (connectionValue) {
    for (const name of connectionValue.split(",")) {
      const trimmed = name.trim().toLowerCase();
      if (trimmed) {
        try {
          cleaned.delete(trimmed);
        } catch {
          // Ignore invalid header names (e.g., malformed Connection tokens)
        }
      }
    }
  }

  for (const h of HOP_BY_HOP_HEADERS) {
    cleaned.delete(h);
  }
  return cleaned;
}

// ---------------------------------------------------------------------------
// Upstream URL construction
// ---------------------------------------------------------------------------

/**
 * Build a full upstream URL by joining a base URL with a path and optional
 * query string. Strips trailing slashes from the base to avoid double-slash
 * path segments.
 */
export function buildUpstreamUrl(
  baseUrl: string,
  path: string,
  search?: string,
): string {
  const normalizedBase = baseUrl.replace(/\/+$/, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const qs = search ?? "";
  return `${normalizedBase}${normalizedPath}${qs}`;
}

// ---------------------------------------------------------------------------
// Auth header injection
// ---------------------------------------------------------------------------

/**
 * Prepare request headers for an upstream call to the assistant runtime.
 *
 * - Strips hop-by-hop headers from the source
 * - Removes the incoming `host` and `authorization` headers
 * - Injects a `Bearer <serviceToken>` authorization header
 *
 * The caller provides the `serviceToken`; this package is intentionally
 * agnostic to the token minting mechanism so it can be used without
 * importing gateway auth internals.
 */
export function prepareUpstreamHeaders(
  source: Headers,
  serviceToken: string,
): Headers {
  const cleaned = stripHopByHop(source);
  cleaned.delete("host");
  cleaned.delete("authorization");
  cleaned.set("authorization", `Bearer ${serviceToken}`);
  return cleaned;
}

// ---------------------------------------------------------------------------
// Timeout helpers
// ---------------------------------------------------------------------------

/**
 * Create an AbortController with a timeout. Returns both the controller and
 * a cleanup function that clears the timer. The timeout fires a
 * `DOMException` with name `"TimeoutError"` to match `AbortSignal.timeout()`
 * semantics.
 */
export function createTimeoutController(timeoutMs: number): {
  controller: AbortController;
  clear: () => void;
} {
  const controller = new AbortController();
  const id = setTimeout(() => {
    controller.abort(
      new DOMException(
        "The operation was aborted due to timeout",
        "TimeoutError",
      ),
    );
  }, timeoutMs);
  return {
    controller,
    clear: () => clearTimeout(id),
  };
}

/**
 * Returns `true` when the error represents a timeout abort (DOMException
 * with name "TimeoutError").
 */
export function isTimeoutError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "TimeoutError";
}

/**
 * Returns `true` when the error represents a connection-level failure
 * (anything that is not a timeout). This covers DNS resolution failures,
 * TCP connect errors, TLS handshake failures, etc.
 */
export function isConnectionError(err: unknown): boolean {
  return err instanceof Error && !isTimeoutError(err);
}
