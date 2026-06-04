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

const PLATFORM_PREFIXES = ["/v1", "/_allauth", "/accounts"] as const;

function isPlatformPath(pathname: string): boolean {
  return PLATFORM_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * Resolve a renderer request to a platform-proxy plan.
 *
 * On `forward`, the request's `Origin` is rewritten to the platform's own
 * origin. The renderer issues this request from `app://vellum.ai` but the
 * platform expects its own origin for CORS/CSRF purposes. All other headers
 * (Authorization, X-CSRFToken, Content-Type, etc.) pass through unchanged.
 */
export function planPlatformForward(
  request: PlatformForwardRequest,
  platformUrl: string,
): PlatformForwardPlan {
  const url = new URL(request.url);
  if (!isPlatformPath(url.pathname)) {
    return { kind: "pass" };
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
