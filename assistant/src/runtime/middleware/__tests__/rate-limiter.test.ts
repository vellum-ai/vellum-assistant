import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { invalidateConfigCache } from "../../../config/loader.js";
import { isLoopbackAddress } from "../auth.js";
import {
  apiRateLimiter,
  ipRateLimiter,
  isRateLimitExemptEndpoint,
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

describe("isRateLimitExemptEndpoint", () => {
  test("exempts the SSE stream and liveness probes", () => {
    // Streaming: 429-ing the events stream drops it and drives a client
    // reconnect + re-bootstrap storm, so it bypasses the per-minute limiter.
    expect(isRateLimitExemptEndpoint("events")).toBe(true);
    // Liveness/readiness probes must always answer.
    expect(isRateLimitExemptEndpoint("health")).toBe(true);
    expect(isRateLimitExemptEndpoint("healthz")).toBe(true);
    expect(isRateLimitExemptEndpoint("readyz")).toBe(true);
  });

  test("does not exempt ordinary data endpoints", () => {
    expect(isRateLimitExemptEndpoint("messages")).toBe(false);
    expect(isRateLimitExemptEndpoint("conversations")).toBe(false);
    expect(isRateLimitExemptEndpoint("home/feed")).toBe(false);
    // Match is exact on the normalized endpoint segment, not a prefix.
    expect(isRateLimitExemptEndpoint("events/replay")).toBe(false);
    expect(isRateLimitExemptEndpoint("")).toBe(false);
  });
});

describe("authenticated API rate limit is configurable", () => {
  const configPath = join(process.env.VELLUM_WORKSPACE_DIR!, "config.json");

  function setConfig(obj: unknown): void {
    writeFileSync(configPath, JSON.stringify(obj));
    invalidateConfigCache();
  }

  function clearConfig(): void {
    if (existsSync(configPath)) {
      rmSync(configPath);
    }
    invalidateConfigCache();
  }

  afterEach(() => {
    clearConfig();
  });

  test("defaults the authenticated remote budget to 300 when unset", () => {
    clearConfig();
    const result = apiRateLimiter.check("cfg-default-key", "/v1/test");
    expect(result.limit).toBe(300);
  });

  test("reads the budget from apiRateLimit config on each check (no restart)", () => {
    clearConfig();
    expect(apiRateLimiter.check("cfg-dynamic-1", "/v1/test").limit).toBe(300);

    setConfig({ apiRateLimit: { authenticatedMaxRequestsPerMinute: 500 } });
    expect(apiRateLimiter.check("cfg-dynamic-2", "/v1/test").limit).toBe(500);
  });

  test("override leaves the loopback and unauthenticated budgets unchanged", () => {
    setConfig({ apiRateLimit: { authenticatedMaxRequestsPerMinute: 750 } });
    expect(apiRateLimiter.check("cfg-auth-key", "/v1/test").limit).toBe(750);
    // Loopback (1200) and unauthenticated (20) budgets are fixed.
    expect(
      loopbackApiRateLimiter.check("cfg-loopback-key", "/v1/test").limit,
    ).toBe(1200);
    expect(ipRateLimiter.check("cfg-ip-key", "/v1/test").limit).toBe(20);
  });
});
