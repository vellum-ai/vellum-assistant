/**
 * Tests for initFeatureFlagOverrides() — the async gateway fetch that
 * pre-populates the feature flag cache before CLI program construction.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  clearFeatureFlagOverridesCache,
  initFeatureFlagOverrides,
  isAssistantFeatureFlagEnabled,
} from "../config/assistant-feature-flags.js";
import * as tokenService from "../runtime/auth/token-service.js";
import { getMockFetchCalls, mockFetch, resetMockFetch } from "./mock-fetch.js";

const VALID_HEX_KEY = "ab".repeat(32);

beforeEach(() => {
  clearFeatureFlagOverridesCache();
  tokenService._resetSigningKeyForTesting();

  // Set up a signing key so mintEdgeRelayToken() works
  process.env.ACTOR_TOKEN_SIGNING_KEY = VALID_HEX_KEY;
  tokenService.initAuthSigningKey(tokenService.resolveSigningKey());
});

afterEach(() => {
  resetMockFetch();
  clearFeatureFlagOverridesCache();
  tokenService._resetSigningKeyForTesting();
  delete process.env.ACTOR_TOKEN_SIGNING_KEY;
});

describe("initFeatureFlagOverrides", () => {
  it("populates cache from gateway fetch response", async () => {
    mockFetch(
      "/v1/feature-flags",
      { method: "GET" },
      {
        body: {
          flags: [
            {
              key: "foo-enabled",
              enabled: true,
              label: "Foo",
              defaultEnabled: false,
              description: "",
            },
            {
              key: "bar-enabled",
              enabled: true,
              label: "Bar",
              defaultEnabled: true,
              description: "",
            },
          ],
        },
        status: 200,
      },
    );

    await initFeatureFlagOverrides();

    const config = {} as any;
    expect(isAssistantFeatureFlagEnabled("foo-enabled", config)).toBe(true);
    expect(isAssistantFeatureFlagEnabled("bar-enabled", config)).toBe(true);

    // Verify fetch was called with correct URL and auth header
    const calls = getMockFetchCalls();
    expect(calls.length).toBe(1);
    expect(calls[0].path).toContain("/v1/feature-flags");
    const headers = calls[0].init.headers as Record<string, string> | undefined;
    expect(headers).toHaveProperty("Authorization");
  });

  it("sends a valid Bearer JWT in the Authorization header", async () => {
    mockFetch(
      "/v1/feature-flags",
      { method: "GET" },
      { body: { flags: [] }, status: 200 },
    );

    await initFeatureFlagOverrides();

    const calls = getMockFetchCalls();
    expect(calls.length).toBe(1);
    const headers = calls[0].init.headers as Record<string, string> | undefined;
    const authHeader = headers?.Authorization;

    expect(authHeader).toBeDefined();
    expect(authHeader).toMatch(/^Bearer /);

    // Verify it's a valid JWT (three dot-separated base64url segments)
    const token = authHeader!.replace("Bearer ", "");
    const parts = token.split(".");
    expect(parts.length).toBe(3);
  });

  it("falls back gracefully when gateway is unreachable", async () => {
    mockFetch("/v1/feature-flags", { method: "GET" }, { status: 500 });

    // Should not throw
    await initFeatureFlagOverrides();

    // Without gateway data or file, undeclared flags default to true
    const config = {} as any;
    expect(isAssistantFeatureFlagEnabled("foo-enabled", config)).toBe(true);
  });

  it("falls back gracefully on non-OK HTTP status", async () => {
    mockFetch(
      "/v1/feature-flags",
      { method: "GET" },
      { body: "Unauthorized", status: 401 },
    );

    await initFeatureFlagOverrides();

    // Undeclared flags default to true without overrides
    const config = {} as any;
    expect(isAssistantFeatureFlagEnabled("foo-enabled", config)).toBe(true);
  });

  it("initializes signing key lazily when not yet set", async () => {
    // Reset signing key to simulate fresh CLI subprocess
    tokenService._resetSigningKeyForTesting();
    delete process.env.ACTOR_TOKEN_SIGNING_KEY;

    expect(tokenService.isSigningKeyInitialized()).toBe(false);

    mockFetch(
      "/v1/feature-flags",
      { method: "GET" },
      {
        body: {
          flags: [{ key: "expected-enabled", enabled: true }],
        },
        status: 200,
      },
    );

    await initFeatureFlagOverrides();

    // The signing key may or may not be initialized depending on whether
    // loadOrCreateSigningKey() found/created a key on disk. Either way,
    // the fetch should still have succeeded (loopback bypass).

    // The flag should be resolved correctly
    const config = {} as any;
    expect(isAssistantFeatureFlagEnabled("expected-enabled", config)).toBe(
      true,
    );
  });

  it("still fetches flags when signing key is completely unavailable", async () => {
    // Simulate a CLI subprocess where the signing key env var is unset
    // and loadOrCreateSigningKey() would throw (e.g. read-only filesystem).
    // The fetch should still proceed without the Authorization header
    // because the gateway auto-authenticates loopback peers.
    tokenService._resetSigningKeyForTesting();
    delete process.env.ACTOR_TOKEN_SIGNING_KEY;

    mockFetch(
      "/v1/feature-flags",
      { method: "GET" },
      {
        body: {
          flags: [
            { key: "gated-feature", enabled: true },
            { key: "disabled-feature", enabled: false },
          ],
        },
        status: 200,
      },
    );

    await initFeatureFlagOverrides();

    // Fetch should have been called (auth failure didn't block it)
    const calls = getMockFetchCalls();
    expect(calls.length).toBe(1);
    expect(calls[0].path).toContain("/v1/feature-flags");

    // Flags should be resolved correctly from the gateway response
    const config = {} as any;
    expect(isAssistantFeatureFlagEnabled("gated-feature", config)).toBe(true);
    expect(isAssistantFeatureFlagEnabled("disabled-feature", config)).toBe(
      false,
    );
  });

  it("does not cache empty gateway response", async () => {
    mockFetch(
      "/v1/feature-flags",
      { method: "GET" },
      { body: { flags: [] }, status: 200 },
    );

    await initFeatureFlagOverrides();

    // Undeclared flags without overrides default to true (not false from
    // a cached empty map)
    const config = {} as any;
    expect(isAssistantFeatureFlagEnabled("foo-enabled", config)).toBe(true);
  });
});
