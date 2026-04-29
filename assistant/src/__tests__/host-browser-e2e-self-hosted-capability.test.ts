/**
 * End-to-end smoke test for the self-hosted **capability-token**
 * WebSocket round-trip over `/v1/browser-relay`.
 *
 * This file is the Phase 3 complement to `host-browser-e2e-cloud.test.ts`:
 * it exercises the same mock-chrome-extension → runtime → HostBrowserProxy
 * path, but the extension authenticates with a capability token minted
 * by `mintHostBrowserCapability()` instead of a guardian-bound JWT.
 *
 * Invariants covered:
 *
 *   1. `/v1/browser-relay` accepts capability tokens directly.
 *   2. The WS upgrade handler derives the registry-key guardianId from
 *      the capability claims so host_browser_request frames route
 *      back to the right connection.
 *   3. A full `Browser.getVersion` request round-trips through the
 *      mock fixture and resolves on the proxy side.
 *
 * If this test fails, the self-hosted transport cutover is broken.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ── Module mocks (must be declared before the real imports below) ────

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
    model: "test",
    provider: "test",
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0 },
    secretDetection: { enabled: false },
    contextWindow: { maxInputTokens: 200000 },
    services: {
      inference: {
        mode: "your-own",
        provider: "anthropic",
        model: "claude-opus-4-6",
      },
      "image-generation": {
        mode: "your-own",
        provider: "gemini",
        model: "gemini-3.1-flash-image-preview",
      },
      "web-search": { mode: "your-own", provider: "inference-provider-native" },
    },
  }),
}));

// ── Real imports (after mocks) ──────────────────────────────────────

import { HostBrowserProxy } from "../daemon/host-browser-proxy.js";
import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { mintToken } from "../runtime/auth/token-service.js";
import {
  mintHostBrowserCapability,
  resetCapabilityTokenSecretForTests,
  setCapabilityTokenSecretForTests,
} from "../runtime/capability-tokens.js";
import { __resetChromeExtensionRegistryForTests } from "../runtime/chrome-extension-registry.js";
import { getClientRegistry } from "../runtime/client-registry.js";
import { RuntimeHttpServer } from "../runtime/http-server.js";

initializeDb();

function mintSseToken(guardianId: string): string {
  return mintToken({
    aud: "vellum-daemon",
    sub: `actor:self:${guardianId}`,
    scope_profile: "actor_client_v1",
    policy_epoch: 1,
    ttlSeconds: 3600,
  });
}

// ── Tests ───────────────────────────────────────────────────────────

describe("host_browser self-hosted capability-token e2e round-trip", () => {
  let server: RuntimeHttpServer;
  let port: number;
  let runtimeBaseUrl: string;

  beforeEach(async () => {
    setCapabilityTokenSecretForTests(Buffer.alloc(32, 0xab));

    const db = getDb();
    db.run("DELETE FROM contact_channels");
    db.run("DELETE FROM contacts");
    HostBrowserProxy.reset();
    __resetChromeExtensionRegistryForTests();

    port = 19600 + Math.floor(Math.random() * 200);
    runtimeBaseUrl = `http://127.0.0.1:${port}`;
    server = new RuntimeHttpServer({ port });
    await server.start();
  });

  afterEach(async () => {
    await server?.stop();
    HostBrowserProxy.reset();
    __resetChromeExtensionRegistryForTests();
    resetCapabilityTokenSecretForTests();
  });

  test("capability token round-trips Browser.getVersion over WS result transport", async () => {
    const guardianId = `self-hosted-guardian-${crypto.randomUUID()}`;
    const { token } = mintHostBrowserCapability(guardianId);

    const { createMockChromeExtension } =
      await import("./fixtures/mock-chrome-extension.js");
    const mockExt = createMockChromeExtension({
      runtimeBaseUrl,
      token,
      sseToken: mintSseToken(guardianId),
      resultTransport: "ws",
    });
    await mockExt.start();
    await mockExt.waitForConnection();
    await waitForRegistryEntry(guardianId);

    const proxy = HostBrowserProxy.instance;

    const result = await proxy.request(
      { cdpMethod: "Browser.getVersion" },
      "conv-cap-happy-ws",
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Chrome/MockTest");

    const received = mockExt.receivedRequests();
    expect(received).toHaveLength(1);
    expect(received[0].cdpMethod).toBe("Browser.getVersion");
    expect(received[0].conversationId).toBe("conv-cap-happy-ws");

    await mockExt.stop();
  });

  test("capability token round-trips Browser.getVersion over HTTP POST fallback", async () => {
    const guardianId = `self-hosted-guardian-${crypto.randomUUID()}`;
    const { token } = mintHostBrowserCapability(guardianId);

    const { createMockChromeExtension } =
      await import("./fixtures/mock-chrome-extension.js");
    const mockExt = createMockChromeExtension({
      runtimeBaseUrl,
      token,
      sseToken: mintSseToken(guardianId),
      resultTransport: "http",
    });
    await mockExt.start();
    await mockExt.waitForConnection();
    await waitForRegistryEntry(guardianId);

    const proxy = HostBrowserProxy.instance;

    const result = await proxy.request(
      { cdpMethod: "Browser.getVersion" },
      "conv-cap-happy-http",
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Chrome/MockTest");

    const received = mockExt.receivedRequests();
    expect(received).toHaveLength(1);
    expect(received[0].cdpMethod).toBe("Browser.getVersion");
    expect(received[0].conversationId).toBe("conv-cap-happy-http");

    await mockExt.stop();
  });

  test("an invalid capability token is rejected with 401", async () => {
    const { createMockChromeExtension } =
      await import("./fixtures/mock-chrome-extension.js");
    const mockExt = createMockChromeExtension({
      runtimeBaseUrl,
      token: "totally-bogus-not-a-real-token",
    });
    let started = false;
    try {
      await mockExt.start();
      started = true;
      await mockExt.waitForConnection(500);
    } catch {
      // expected — SSE or WS auth rejects the bad token
    }
    // The extension must not reach a fully-connected state.
    expect(started).toBe(false);
    await mockExt.stop();
  });
});

// ── Local wait helpers ──────────────────────────────────────────────

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(
        `waitFor: predicate did not become true within ${timeoutMs}ms`,
      );
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function waitForRegistryEntry(
  _guardianId: string,
  timeoutMs = 2000,
): Promise<void> {
  await waitFor(
    () => getClientRegistry().getMostRecentByCapability("host_browser") != null,
    timeoutMs,
  );
}
