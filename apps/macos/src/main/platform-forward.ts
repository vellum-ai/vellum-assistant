/**
 * Pure planning for the platform API proxy (`/v1/*`, `/_allauth/*`, `/accounts/*`).
 *
 * Mirrors `gateway-forward.ts`: the URL/header logic is testable without
 * importing `src/main/index.ts` or mocking Electron's `net`. The caller in
 * `index.ts` turns a `forward` plan into a single `net.fetch` and returns its
 * streaming `Response` verbatim.
 */

export type PlatformForwardPlan =
  | { kind: "pass" }
  | { kind: "reject"; status: number; message: string }
  | {
      kind: "forward";
      url: string;
      method: string;
      headers: Headers;
      hasBody: boolean;
    };

export interface PlatformForwardRequest {
  url: string;
  method: string;
  headers: Headers;
}

export interface PlatformForwardAllowedOrigin {
  protocol: string;
  host: string;
}

export interface PlatformForwardOptions {
  allowedOrigin?: PlatformForwardAllowedOrigin;
  /** Token value, or a lazy getter only invoked once a platform path matches. */
  sessionToken?: string | null | (() => string | null);
}

const PLATFORM_PREFIXES = ["/v1", "/_allauth", "/accounts"] as const;
const BROWSER_ALLAUTH_PREFIX = "/_allauth/browser/";
const APP_ALLAUTH_PREFIX = "/_allauth/app/";
const ELECTRON_RENDERER_ORIGIN_HEADER = "X-Vellum-Electron-Renderer-Origin";

function isPlatformPath(pathname: string): boolean {
  return PLATFORM_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function isAllowedSource(
  value: string | null,
  allowed: PlatformForwardAllowedOrigin,
): boolean {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === allowed.protocol && parsed.host === allowed.host;
  } catch {
    return false;
  }
}

function isUnsafeMethod(method: string): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}

function resolveSessionToken(
  sessionToken: PlatformForwardOptions["sessionToken"],
): string | null {
  return typeof sessionToken === "function"
    ? sessionToken()
    : (sessionToken ?? null);
}

function expectedRendererOrigin(allowed: PlatformForwardAllowedOrigin): string {
  return `${allowed.protocol}//${allowed.host}`;
}

/**
 * The Electron renderer authenticates against allauth's header-token "app"
 * client. A renderer that fails to detect the Electron host (e.g. the preload
 * bridge was unavailable) falls back to the cookie-based "browser" client,
 * which can never authenticate through the cookie-less proxy
 * (`credentials: "omit"`). When the main process holds a session token,
 * retarget those requests at the app client.
 */
function platformPathnameForForward(
  pathname: string,
  sessionToken: string | null | undefined,
): string {
  if (sessionToken && pathname.startsWith(BROWSER_ALLAUTH_PREFIX)) {
    return `${APP_ALLAUTH_PREFIX}${pathname.slice(BROWSER_ALLAUTH_PREFIX.length)}`;
  }
  return pathname;
}

/**
 * Chromium omits the `Origin` header on requests to Electron custom protocol
 * handlers (`app://`), so standard origin-checking cannot trust them. Fall
 * back to two signals that ARE present:
 *
 *   1. `X-Vellum-Electron-Renderer-Origin` — set by the renderer's API
 *      interceptor on mutating requests, stripped before forwarding.
 *   2. `Sec-Fetch-Site: same-origin` — browser-controlled Fetch Metadata
 *      header that page JS cannot forge.
 *
 * Both checks additionally verify the request URL itself targets the
 * expected app origin, preventing a hypothetical cross-origin sub-resource
 * from satisfying the check.
 */
function hasTrustedSourceLessRendererSignal(
  requestUrl: URL,
  headers: Headers,
  allowed: PlatformForwardAllowedOrigin,
): boolean {
  if (
    requestUrl.protocol !== allowed.protocol ||
    requestUrl.host !== allowed.host
  ) {
    return false;
  }

  if (
    headers.get(ELECTRON_RENDERER_ORIGIN_HEADER) ===
    expectedRendererOrigin(allowed)
  ) {
    return true;
  }

  return headers.get("sec-fetch-site") === "same-origin";
}

function getInitiatorTrust(
  requestUrl: URL,
  headers: Headers,
  allowed?: PlatformForwardAllowedOrigin,
): { trusted: boolean; rejected: boolean } {
  if (!allowed) return { trusted: false, rejected: false };

  const origin = headers.get("origin");
  if (origin) {
    const trusted = isAllowedSource(origin, allowed);
    return { trusted, rejected: !trusted };
  }

  const referer = headers.get("referer");
  if (!referer) {
    return {
      trusted: hasTrustedSourceLessRendererSignal(
        requestUrl,
        headers,
        allowed,
      ),
      rejected: false,
    };
  }

  const trusted = isAllowedSource(referer, allowed);
  return { trusted, rejected: !trusted };
}

/**
 * Resolve a renderer request to a platform-proxy plan.
 *
 * On `forward`, the request's `Origin` is rewritten to the platform's own
 * origin. The renderer issues this request from `app://vellum.ai` but the
 * platform expects its own origin for CORS purposes. Unsafe requests are only
 * forwarded when their browser-controlled `Origin` or `Referer` matches the
 * trusted renderer origin. All other headers pass through unchanged.
 */
export function planPlatformForward(
  request: PlatformForwardRequest,
  platformUrl: string,
  options: PlatformForwardOptions = {},
): PlatformForwardPlan {
  const url = new URL(request.url);
  if (!isPlatformPath(url.pathname)) {
    return { kind: "pass" };
  }

  const initiator = getInitiatorTrust(
    url,
    request.headers,
    options.allowedOrigin,
  );
  const unsafeUntrustedRequest =
    options.allowedOrigin &&
    isUnsafeMethod(request.method) &&
    !initiator.trusted;
  if (initiator.rejected || unsafeUntrustedRequest) {
    return {
      kind: "reject",
      status: 403,
      message: "Forbidden platform proxy request",
    };
  }

  // Inject the token on any forwarded request that lacks one. This cannot
  // be gated on initiator trust: Chromium omits Origin on same-origin GETs
  // and sends no Referer/Sec-Fetch metadata over the app:// scheme, so the
  // renderer's own session check carries no trust signal. Unsafe methods
  // from untrusted initiators were already rejected above.
  const sessionToken = resolveSessionToken(options.sessionToken);
  const pathname = platformPathnameForForward(url.pathname, sessionToken);

  const target = new URL(platformUrl);
  const headers = new Headers(request.headers);
  headers.delete(ELECTRON_RENDERER_ORIGIN_HEADER);
  headers.set("origin", target.origin);
  if (sessionToken && !headers.has("X-Session-Token")) {
    headers.set("X-Session-Token", sessionToken);
  }

  return {
    kind: "forward",
    url: `${target.origin}${pathname}${url.search}`,
    method: request.method,
    headers,
    hasBody: request.method !== "GET" && request.method !== "HEAD",
  };
}
