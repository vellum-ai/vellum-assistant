import { describe, expect, test } from "bun:test";

import { isLoopbackAddress } from "../auth.js";
import {
  apiRateLimiter,
  loopbackApiRateLimiter,
  selectAuthenticatedRateLimiter,
} from "../rate-limiter.js";

describe("isLoopbackAddress", () => {
  test("accepts loopback addresses", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("127.42.0.7")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
  });

  test("rejects private (non-loopback) and public addresses", () => {
    expect(isLoopbackAddress("10.0.0.1")).toBe(false);
    expect(isLoopbackAddress("192.168.1.20")).toBe(false);
    expect(isLoopbackAddress("172.16.0.5")).toBe(false);
    expect(isLoopbackAddress("169.254.0.1")).toBe(false);
    expect(isLoopbackAddress("::ffff:10.0.0.1")).toBe(false);
    expect(isLoopbackAddress("fe80::1")).toBe(false);
    expect(isLoopbackAddress("fd00::1")).toBe(false);
    expect(isLoopbackAddress("8.8.8.8")).toBe(false);
  });

  test("rejects malformed input", () => {
    expect(isLoopbackAddress("")).toBe(false);
    expect(isLoopbackAddress("localhost")).toBe(false);
    expect(isLoopbackAddress("127.0.0")).toBe(false);
    expect(isLoopbackAddress("127.0.0.999")).toBe(false);
  });
});

describe("selectAuthenticatedRateLimiter", () => {
  test("loopback clients get the higher-budget limiter", () => {
    expect(selectAuthenticatedRateLimiter("127.0.0.1")).toBe(
      loopbackApiRateLimiter,
    );
    expect(selectAuthenticatedRateLimiter("::1")).toBe(loopbackApiRateLimiter);
    expect(selectAuthenticatedRateLimiter("::ffff:127.0.0.1")).toBe(
      loopbackApiRateLimiter,
    );
  });

  test("remote and LAN clients get the standard limiter", () => {
    expect(selectAuthenticatedRateLimiter("192.168.1.20")).toBe(apiRateLimiter);
    expect(selectAuthenticatedRateLimiter("203.0.113.9")).toBe(apiRateLimiter);
  });

  test("loopback budget exceeds the standard budget", () => {
    const loopback = loopbackApiRateLimiter.check(
      "test-loopback-budget",
      "/v1/test",
    );
    const standard = apiRateLimiter.check("test-standard-budget", "/v1/test");
    expect(loopback.limit).toBeGreaterThan(standard.limit);
    expect(loopback.limit).toBe(1200);
    expect(standard.limit).toBe(300);
  });
});
