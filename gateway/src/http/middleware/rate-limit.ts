import type { AuthRateLimiter } from "../../auth-rate-limiter.js";
import { getLogger } from "../../logger.js";
import { isLoopbackAddress } from "../../util/is-loopback-address.js";

const log = getLogger("rate-limit");

/**
 * Check whether a request should be rate-limited based on prior auth failures.
 *
 * Returns a 429 Response if the client IP is blocked, or null to continue.
 *
 * Loopback peers (127.0.0.0/8, ::1, and IPv4-mapped IPv6 equivalents) are
 * exempt: a misbehaving local client that can't attach a bearer token must
 * not be able to rate-limit the whole gateway for everything else coming
 * from the same machine (the CLI's `vellum ps`, skill HTTP calls via
 * `$INTERNAL_GATEWAY_BASE_URL`, etc.). The auth middleware already bypasses
 * loopback for token validation; this keeps the rate limiter consistent
 * with that policy.
 *
 * The limiter still accumulates failure timestamps for loopback IPs via
 * `wrapWithAuthFailureTracking` and other upstream callers of
 * `recordFailure`. Since loopback peers never get the 429, `isBlocked` is
 * never invoked for them — which is the only path that prunes expired
 * timestamps — so we explicitly `clearIp` here on every check to keep
 * the per-IP failure map from growing unboundedly.
 */
export function checkAuthRateLimit(
  url: URL,
  authRateLimiter: AuthRateLimiter,
  clientIp: string,
): Response | null {
  if (!isRateLimitedRoute(url)) return null;
  if (isLoopbackAddress(clientIp)) {
    authRateLimiter.clearIp(clientIp);
    return null;
  }

  if (authRateLimiter.isBlocked(clientIp)) {
    log.warn({ ip: clientIp, path: url.pathname }, "Auth rate limit exceeded");
    return Response.json(
      { error: "Too many failed attempts. Try again later." },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  }

  return null;
}

/**
 * Routes subject to the auth-failure rate limiter: authenticated endpoints,
 * pairing endpoints, and unauthenticated endpoints that forward to the
 * runtime (OAuth callback is publicly reachable and forwards every
 * valid-looking request).
 *
 * Excluded: Twilio webhook/relay and browser-relay paths which use their
 * own authentication mechanisms (Twilio signature validation, etc.).
 */
function isRateLimitedRoute(url: URL): boolean {
  return (
    url.pathname === "/integrations/status" ||
    url.pathname === "/deliver/telegram" ||
    url.pathname === "/deliver/slack" ||
    url.pathname.startsWith("/pairing/") ||
    url.pathname === "/webhooks/oauth/callback" ||
    (url.pathname.startsWith("/v1/") && url.pathname !== "/v1/browser-relay")
  );
}
