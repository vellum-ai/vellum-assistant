/**
 * Tests for initFeatureFlagOverrides() — the async gateway fetch that
 * pre-populates the feature flag cache before CLI program construction.
 *
 * Mocks global `fetch` (not Bun.spawnSync) to simulate gateway responses.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

const {
  initFeatureFlagOverrides,
  isAssistantFeatureFlagEnabled,
  clearFeatureFlagOverridesCache,
} = await import("../config/assistant-feature-flags.js");

const tokenService = await import("../runtime/auth/token-service.js");

const VALID_HEX_KEY = "ab".repeat(32);

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  clearFeatureFlagOverridesCache();
  tokenService._resetSigningKeyForTesting();

  // Set up a signing key so mintEdgeRelayToken() works
  process.env.ACTOR_TOKEN_SIGNING_KEY = VALID_HEX_KEY;
  tokenService.initAuthSigningKey(tokenService.resolveSigningKey());
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearFeatureFlagOverridesCache();
  tokenService._resetSigningKeyForTesting();
  delete process.env.ACTOR_TOKEN_SIGNING_KEY;
});

describe("initFeatureFlagOverrides", () => {
  it("populates cache from gateway fetch response", async () => {
    let capturedUrl: string | undefined;
    let capturedHeaders: Record<string, string> | undefined;

    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      capturedUrl = String(input);
      capturedHeaders = init?.headers as Record<string, string>;
      return Response.json({
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
      });
    }) as typeof fetch;

    await initFeatureFlagOverrides();

    // email-channel defaults to false in the registry — should now be true
    const config = {} as any;
    expect(isAssistantFeatureFlagEnabled("email-channel", config)).toBe(true);

    // Verify fetch was called with correct URL and auth header
    expect(capturedUrl).toContain("/v1/feature-flags");
    expect(capturedHeaders).toHaveProperty("Authorization");
  });

  it("sends a valid Bearer JWT in the Authorization header", async () => {
    let capturedAuthHeader: string | undefined;

    globalThis.fetch = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const headers = init?.headers as Record<string, string> | undefined;
      capturedAuthHeader = headers?.Authorization;
      return Response.json({ flags: [] });
    }) as typeof fetch;

    await initFeatureFlagOverrides();

    expect(capturedAuthHeader).toBeDefined();
    expect(capturedAuthHeader).toMatch(/^Bearer /);

    // Verify it's a valid JWT (three dot-separated base64url segments)
    const token = capturedAuthHeader!.replace("Bearer ", "");
    const parts = token.split(".");
    expect(parts.length).toBe(3);
  });

  it("falls back to file when gateway is unreachable", async () => {
    globalThis.fetch = (() => {
      return Promise.reject(new Error("ECONNREFUSED"));
    }) as unknown as typeof fetch;

    // Should not throw — graceful fallback
    await initFeatureFlagOverrides();

    // Without gateway data or file, email-channel falls through to
    // registry default (false)
    const config = {} as any;
    expect(isAssistantFeatureFlagEnabled("email-channel", config)).toBe(false);
  });

  it("falls back to file on non-OK HTTP status", async () => {
    globalThis.fetch = (async () => {
      return new Response("Unauthorized", { status: 401 });
    }) as unknown as typeof fetch;

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

    const mockFetch = mock(() =>
      Promise.resolve(
        Response.json({
          flags: [{ key: "email-channel", enabled: true }],
        }),
      ),
    );
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    await initFeatureFlagOverrides();

    // Signing key should have been initialized during the fetch
    expect(tokenService.isSigningKeyInitialized()).toBe(true);

    // And the flag should be resolved correctly
    const config = {} as any;
    expect(isAssistantFeatureFlagEnabled("email-channel", config)).toBe(true);
  });
});
