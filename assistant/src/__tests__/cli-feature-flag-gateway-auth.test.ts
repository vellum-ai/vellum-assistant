/**
 * Verify that CLI-invoked feature flag resolution initializes the auth
 * signing key and sends a valid JWT to the gateway.
 *
 * Regression test: CLI subprocesses (assistant/src/index.ts) don't run
 * daemon startup, so the signing key was never initialized. This caused
 * mintEdgeRelayToken() to throw, loadOverridesFromGateway() to silently
 * return {}, and all feature flags to fall through to registry defaults.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

/* eslint-disable @typescript-eslint/no-require-imports --
 * Dynamic require() is intentional here: we need to access the live
 * module-level singletons (_authSigningKey, cachedOverrides) at call
 * time, not the snapshot captured at top-level import time.
 */

describe("CLI feature flag gateway auth", () => {
  let originalSpawnSync: typeof Bun.spawnSync;
  let capturedAuthHeader: string | undefined;

  beforeEach(() => {
    capturedAuthHeader = undefined;
    originalSpawnSync = Bun.spawnSync;

    // Reset the signing key to simulate a fresh CLI subprocess where
    // initAuthSigningKey() was never called (no daemon startup).
    const tokenService =
      require("../runtime/auth/token-service.js") as typeof import("../runtime/auth/token-service.js");
    tokenService._resetSigningKeyForTesting();

    // Mock Bun.spawnSync to intercept the curl call and return a fake
    // gateway response with email-channel: true
    const spawnSyncMock = mock((...args: unknown[]) => {
      const argv = args[0] as string[];
      if (Array.isArray(argv) && argv[0] === "curl") {
        // Extract the Authorization header from the curl args
        for (let i = 0; i < argv.length; i++) {
          if (argv[i] === "-H" && argv[i + 1]?.startsWith("Authorization:")) {
            capturedAuthHeader = argv[i + 1];
          }
        }

        const body = JSON.stringify({
          flags: [
            { key: "email-channel", enabled: true },
            { key: "browser", enabled: true },
          ],
        });

        return {
          exitCode: 0,
          stdout: Buffer.from(body + "\n200"),
          stderr: Buffer.from(""),
          success: true,
        };
      }
      return originalSpawnSync.apply(
        Bun,
        args as Parameters<typeof Bun.spawnSync>,
      );
    });
    // @ts-expect-error — Bun.spawnSync is read-only but we need to mock it
    Bun.spawnSync = spawnSyncMock;
  });

  afterEach(() => {
    // @ts-expect-error — restoring Bun.spawnSync
    Bun.spawnSync = originalSpawnSync;

    // Reset module-level caches so subsequent tests start clean
    const flags =
      require("../config/assistant-feature-flags.js") as typeof import("../config/assistant-feature-flags.js");
    flags.clearFeatureFlagOverridesCache();

    // Reset signing key so we don't leak state to other test files
    const tokenService =
      require("../runtime/auth/token-service.js") as typeof import("../runtime/auth/token-service.js");
    tokenService._resetSigningKeyForTesting();
  });

  it("initializes signing key and sends a valid Bearer JWT to the gateway", () => {
    // Verify the signing key is NOT initialized before we start —
    // simulating a fresh CLI subprocess that never ran daemon startup
    const tokenService =
      require("../runtime/auth/token-service.js") as typeof import("../runtime/auth/token-service.js");
    expect(tokenService.isSigningKeyInitialized()).toBe(false);

    // Clear cached overrides to force a fresh gateway call
    const flags =
      require("../config/assistant-feature-flags.js") as typeof import("../config/assistant-feature-flags.js");
    flags.clearFeatureFlagOverridesCache();

    const config = {} as any;
    const result = flags.isAssistantFeatureFlagEnabled("email-channel", config);

    // Without the fix, mintEdgeRelayToken() throws "Auth signing key not
    // initialized", loadOverridesFromGateway() catches and returns {},
    // and email-channel falls through to the registry default (false).
    //
    // With the fix, the signing key is lazily initialized, the JWT is
    // minted, curl is called (hitting our mock), and the gateway response
    // with email-channel: true is used.
    expect(result).toBe(true);

    // Verify that the signing key was initialized during resolution
    expect(tokenService.isSigningKeyInitialized()).toBe(true);

    // Verify that an Authorization header was sent to the gateway
    expect(capturedAuthHeader).toBeDefined();
    expect(capturedAuthHeader).toMatch(/^Authorization: Bearer /);

    // Verify it's a valid JWT (three dot-separated base64url segments)
    const token = capturedAuthHeader!.replace("Authorization: Bearer ", "");
    const parts = token.split(".");
    expect(parts.length).toBe(3);
  });
});
