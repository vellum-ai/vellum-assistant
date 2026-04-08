import { getLogger } from "../../logger.js";

const log = getLogger("cors");

/**
 * Pattern matching origins from the embedded WKWebView.
 *
 * The macOS app loads webview content from `https://{appId}.vellum.local/`,
 * which is cross-origin relative to the local gateway at
 * `http://127.0.0.1:{port}`. Without CORS headers, the browser blocks
 * `window.vellum.fetch` requests from the webview to the gateway.
 */
const WEBVIEW_ORIGIN_RE = /^https:\/\/[a-z0-9-]+\.vellum\.local$/;

/**
 * Methods the webview bridge may use when calling custom route handlers.
 */
const ALLOWED_METHODS = "GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS";

/**
 * Headers the webview bridge sends (auth + content type + org id).
 */
const ALLOWED_HEADERS =
  "Authorization, Content-Type, X-Session-Token, Vellum-Organization-Id, X-Trace-Id";

/**
 * Check whether the request `Origin` header matches a known webview origin.
 * Returns the validated origin string, or null if CORS headers should not be
 * added.
 */
export function resolveWebviewOrigin(req: Request): string | null {
  const origin = req.headers.get("origin");
  if (!origin) return null;
  if (!WEBVIEW_ORIGIN_RE.test(origin)) return null;
  return origin;
}

/**
 * Build the CORS response headers for a matched webview origin.
 *
 * The origin is reflected back (not `*`) so credentials-mode requests work
 * and the scope is limited to the app's own webview.
 */
export function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": ALLOWED_METHODS,
    "Access-Control-Allow-Headers": ALLOWED_HEADERS,
    "Access-Control-Max-Age": "86400",
  };
}

/**
 * Handle a CORS preflight (OPTIONS) request for a matched webview origin.
 * Returns a 204 No Content with all required CORS headers.
 */
export function handlePreflight(origin: string): Response {
  log.debug({ origin }, "CORS preflight response");
  return new Response(null, {
    status: 204,
    headers: corsHeaders(origin),
  });
}

/**
 * Append CORS headers to an existing response for a matched webview origin.
 *
 * Because Response headers may be immutable (e.g. from `Response.json()`),
 * this clones the response with merged headers when necessary.
 */
export function withCorsHeaders(response: Response, origin: string): Response {
  const headers = corsHeaders(origin);
  try {
    for (const [key, value] of Object.entries(headers)) {
      response.headers.set(key, value);
    }
    return response;
  } catch {
    // Headers are immutable — rebuild with merged headers
    const merged = new Headers(response.headers);
    for (const [key, value] of Object.entries(headers)) {
      merged.set(key, value);
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: merged,
    });
  }
}
