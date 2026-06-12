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
}

const PLATFORM_PREFIXES = ["/v1", "/_allauth", "/accounts"] as const;
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

function expectedRendererOrigin(allowed: PlatformForwardAllowedOrigin): string {
  return `${allowed.protocol}//${allowed.host}`;
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

  const target = new URL(platformUrl);
  const headers = new Headers(request.headers);
  headers.delete(ELECTRON_RENDERER_ORIGIN_HEADER);
  headers.set("origin", target.origin);

  return {
    kind: "forward",
    url: `${target.origin}${url.pathname}${url.search}`,
    method: request.method,
    headers,
    hasBody: request.method !== "GET" && request.method !== "HEAD",
  };
}

/**
 * Error code carried in the JSON body of a proxy-synthesized 502 so the
 * renderer can tell "the proxy's own `net.fetch` failed" apart from a real
 * platform answer. Mirrors `PROXY_NETWORK_ERROR_CODE` in
 * `apps/web/src/assistant/lifecycle.ts`; the two must stay in sync, but
 * there is no shared package between the renderer and the Electron main
 * bundle to host the constant.
 */
export const PROXY_NETWORK_ERROR_CODE = "proxy_network_error";

/** Marker header on proxy-synthesized error responses. */
export const PROXY_ERROR_HEADER = "X-Vellum-Proxy-Error";

const PROXY_NETWORK_ERROR_DETAIL =
  "Couldn't reach Vellum. Check your internet connection and try again.";

/**
 * Chromium net-stack failures that resolve on their own within seconds —
 * the classic case is `ERR_NETWORK_CHANGED` while Wi-Fi reassociates after
 * sleep/wake (LUM-2402). Worth a quick in-proxy retry before bothering the
 * renderer.
 */
const TRANSIENT_NET_ERROR_CODES = [
  "ERR_NETWORK_CHANGED",
  "ERR_INTERNET_DISCONNECTED",
  "ERR_NAME_NOT_RESOLVED",
  "ERR_CONNECTION_RESET",
] as const;

export function isTransientNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return TRANSIENT_NET_ERROR_CODES.some((code) => err.message.includes(code));
}

/**
 * The 502 returned when the proxy's own `net.fetch` rejected. Structured
 * (JSON `detail` + `code`, marker header) instead of the raw Chromium
 * message so the renderer never renders `net::ERR_*` strings and can
 * classify the failure as transport-shaped.
 */
export function buildProxyNetworkErrorResponse(): Response {
  return new Response(
    JSON.stringify({
      detail: PROXY_NETWORK_ERROR_DETAIL,
      code: PROXY_NETWORK_ERROR_CODE,
    }),
    {
      status: 502,
      headers: {
        "Content-Type": "application/json",
        [PROXY_ERROR_HEADER]: "network",
      },
    },
  );
}

export interface ForwardFetchRetryOptions {
  /** Extra attempts after the first failure. */
  retries?: number;
  retryDelayMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Per-failure observer (logging); receives every rejected attempt. */
  onError?: (err: unknown, attempt: number) => void;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run a forward plan's fetch with retry-on-transient-failure semantics.
 * Only bodiless idempotent requests (GET/HEAD) retry — anything with a
 * body streams `request.body`, which is single-use, and non-idempotent
 * methods must not be silently replayed. Exhausted or non-transient
 * failures collapse into the structured 502 instead of rejecting, so the
 * protocol handler never propagates a raw error to the renderer.
 */
export async function fetchForwardPlanWithRetry(
  plan: { method: string; hasBody: boolean },
  doFetch: () => Promise<Response>,
  options: ForwardFetchRetryOptions = {},
): Promise<Response> {
  const {
    retries = 2,
    retryDelayMs = 500,
    sleep = defaultSleep,
    onError,
  } = options;
  const retryable =
    !plan.hasBody && ["GET", "HEAD"].includes(plan.method.toUpperCase());

  for (let attempt = 0; ; attempt++) {
    try {
      return await doFetch();
    } catch (err) {
      onError?.(err, attempt);
      const canRetry =
        retryable && attempt < retries && isTransientNetworkError(err);
      if (!canRetry) return buildProxyNetworkErrorResponse();
      await sleep(retryDelayMs);
    }
  }
}
