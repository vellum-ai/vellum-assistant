import type { AuthRateLimiter } from "../../auth-rate-limiter.js";
import { getLogger } from "../../logger.js";

const log = getLogger("rate-limit");

/**
 * Check whether a request should be rate-limited based on prior auth failures.
 *
 * Returns a 429 Response if the client IP is blocked, or null to continue.
 */
export function checkAuthRateLimit(
  url: URL,
  authRateLimiter: AuthRateLimiter,
  clientIp: string,
): Response | null {
  if (!isRateLimitedRoute(url)) return null;

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
    url.pathname === "/deliver/sms" ||
    url.pathname === "/deliver/whatsapp" ||
    url.pathname === "/deliver/slack" ||
    url.pathname.startsWith("/pairing/") ||
    url.pathname === "/webhooks/oauth/callback" ||
    (url.pathname.startsWith("/v1/") &&
      url.pathname !== "/v1/calls/twilio/voice-webhook" &&
      url.pathname !== "/v1/calls/twilio/status" &&
      url.pathname !== "/v1/calls/twilio/connect-action" &&
      url.pathname !== "/v1/browser-relay" &&
      url.pathname !== "/v1/browser-relay/token" &&
      url.pathname !== "/v1/calls/relay")
  );
}
