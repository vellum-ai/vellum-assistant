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

function getInitiatorTrust(
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
  if (!referer) return { trusted: false, rejected: false };

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

  const initiator = getInitiatorTrust(request.headers, options.allowedOrigin);
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
  headers.set("origin", target.origin);

  return {
    kind: "forward",
    url: `${target.origin}${url.pathname}${url.search}`,
    method: request.method,
    headers,
    hasBody: request.method !== "GET" && request.method !== "HEAD",
  };
}
