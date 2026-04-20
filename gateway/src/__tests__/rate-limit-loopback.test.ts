import { describe, expect, test } from "bun:test";

import { AuthRateLimiter } from "../auth-rate-limiter.js";
import { checkAuthRateLimit } from "../http/middleware/rate-limit.js";

const URL_V1 = new URL("http://local/v1/assistants/foo/identity/");

function blockedLimiter(ip: string, failures = 20): AuthRateLimiter {
  const limiter = new AuthRateLimiter();
  for (let i = 0; i < failures; i++) limiter.recordFailure(ip);
  return limiter;
}

describe("checkAuthRateLimit loopback exemption", () => {
  test("blocks non-loopback peers that exceed the threshold", () => {
    const ip = "203.0.113.5";
    const limiter = blockedLimiter(ip);
    expect(limiter.isBlocked(ip)).toBe(true);

    const res = checkAuthRateLimit(URL_V1, limiter, ip);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(429);
  });

  test("exempts plain IPv4 loopback (127.0.0.1)", () => {
    const ip = "127.0.0.1";
    const limiter = blockedLimiter(ip);
    expect(limiter.isBlocked(ip)).toBe(true);

    expect(checkAuthRateLimit(URL_V1, limiter, ip)).toBeNull();
  });

  test("exempts IPv4 loopback anywhere in 127.0.0.0/8", () => {
    const ip = "127.50.1.2";
    expect(checkAuthRateLimit(URL_V1, blockedLimiter(ip), ip)).toBeNull();
  });

  test("exempts IPv6 loopback (::1)", () => {
    const ip = "::1";
    expect(checkAuthRateLimit(URL_V1, blockedLimiter(ip), ip)).toBeNull();
  });

  test("exempts IPv4-mapped IPv6 loopback (::ffff:127.0.0.1)", () => {
    const ip = "::ffff:127.0.0.1";
    expect(checkAuthRateLimit(URL_V1, blockedLimiter(ip), ip)).toBeNull();
  });

  test("returns null for unrelated routes regardless of block state", () => {
    const ip = "203.0.113.5";
    const limiter = blockedLimiter(ip);
    const res = checkAuthRateLimit(
      new URL("http://local/v1/browser-relay"),
      limiter,
      ip,
    );
    expect(res).toBeNull();
  });
});
