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
import {
  getMockFetchCalls,
  mockFetch,
  resetMockFetch,
} from "./mock-fetch.js";

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
              key: "email-channel",
              enabled: true,
              label: "Email",
              defaultEnabled: false,
              description: "",
            },
            {
              key: "browser",
              enabled: true,
              label: "Browser",
              defaultEnabled: true,
              description: "",
            },
          ],
        },
        status: 200,
      },
    );

    await initFeatureFlagOverrides();

    // email-channel defaults to false in the registry — should now be true
    const config = {} as any;
    expect(isAssistantFeatureFlagEnabled("email-channel", config)).toBe(true);

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

  it("falls back to file when gateway is unreachable", async () => {
    // Register a mock that returns a network error via a Response with
    // status 500. The shared mock-fetch utility doesn't support rejecting
    // promises directly, but fetchOverridesFromGateway treats non-OK as
    // a failure and returns {}.
    mockFetch(
      "/v1/feature-flags",
      { method: "GET" },
      { status: 500 },
    );

    // Should not throw — graceful fallback
    await initFeatureFlagOverrides();

    // Without gateway data or file, email-channel falls through to
    // registry default (false)
    const config = {} as any;
    expect(isAssistantFeatureFlagEnabled("email-channel", config)).toBe(false);
  });

  it("falls back to file on non-OK HTTP status", async () => {
    mockFetch(
      "/v1/feature-flags",
      { method: "GET" },
      { body: "Unauthorized", status: 401 },
    );

    await initFeatureFlagOverrides();

    const config = {} as any;
    expect(isAssistantFeatureFlagEnabled("email-channel", config)).toBe(false);
  });

  it("initializes signing key lazily when not yet set", async () => {
    // Reset signing key to simulate fresh CLI subprocess
    tokenService._resetSigningKeyForTesting();
    delete process.env.ACTOR_TOKEN_SIGNING_KEY;

    // resolveSigningKey() will generate a key from disk when env var is unset
    expect(tokenService.isSigningKeyInitialized()).toBe(false);

    mockFetch(
      "/v1/feature-flags",
      { method: "GET" },
      {
        body: { flags: [{ key: "email-channel", enabled: true }] },
        status: 200,
      },
    );

    await initFeatureFlagOverrides();

    // Signing key should have been initialized during the fetch
    expect(tokenService.isSigningKeyInitialized()).toBe(true);

    // And the flag should be resolved correctly
    const config = {} as any;
    expect(isAssistantFeatureFlagEnabled("email-channel", config)).toBe(true);
  });
});
