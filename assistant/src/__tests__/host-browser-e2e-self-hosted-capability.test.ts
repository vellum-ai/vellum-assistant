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
import type { ServerMessage } from "../daemon/message-protocol.js";
import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import {
  mintHostBrowserCapability,
  resetCapabilityTokenSecretForTests,
  setCapabilityTokenSecretForTests,
} from "../runtime/capability-tokens.js";
import {
  __resetChromeExtensionRegistryForTests,
  getChromeExtensionRegistry,
} from "../runtime/chrome-extension-registry.js";
import { RuntimeHttpServer } from "../runtime/http-server.js";
import * as pendingInteractions from "../runtime/pending-interactions.js";

initializeDb();

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Point `HostBrowserProxy.instance` at the test's proxy so the
 * `/v1/host-browser-result` handler can resolve results correctly.
 */
let activeTestProxy: HostBrowserProxy | null = null;
Object.defineProperty(HostBrowserProxy, "instance", {
  get() {
    return activeTestProxy ?? undefined;
  },
  configurable: true,
});

function createBoundProxy(
  guardianId: string,
  conversationId: string,
): { proxy: HostBrowserProxy } {
  const sendToClient = (msg: ServerMessage) => {
    if ((msg as { type: string }).type === "host_browser_request") {
      const requestId = (msg as { requestId: string }).requestId;
      pendingInteractions.register(requestId, {
        conversation: null,
        conversationId,
        kind: "host_browser",
      });
    }
    const ok = getChromeExtensionRegistry().send(guardianId, msg);
    if (!ok) {
      throw new Error(
        `chrome-extension host_browser send failed: no active connection for guardian ${guardianId}`,
      );
    }
  };

  const proxy = new HostBrowserProxy(sendToClient);
  activeTestProxy = proxy;
  return { proxy };
}

// ── Tests ───────────────────────────────────────────────────────────

describe("host_browser self-hosted capability-token e2e round-trip", () => {
  let server: RuntimeHttpServer;
  let port: number;
  let runtimeBaseUrl: string;

  beforeEach(async () => {
    // Inject a deterministic secret so mintHostBrowserCapability works
    // in-process without a live gateway.
    setCapabilityTokenSecretForTests(Buffer.alloc(32, 0xab));

    // Each test gets a clean DB and a fresh registry so connection
    // state doesn't leak between cases.
    const db = getDb();
    db.run("DELETE FROM contact_channels");
    db.run("DELETE FROM contacts");
    pendingInteractions.clear();
    __resetChromeExtensionRegistryForTests();

    port = 19600 + Math.floor(Math.random() * 200);
    runtimeBaseUrl = `http://127.0.0.1:${port}`;
    server = new RuntimeHttpServer({ port });
    await server.start();
  });

  afterEach(async () => {
    await server?.stop();
    pendingInteractions.clear();
    __resetChromeExtensionRegistryForTests();
    resetCapabilityTokenSecretForTests();
  });

  test("capability token round-trips Browser.getVersion over WS result transport", async () => {
    const guardianId = `self-hosted-guardian-${crypto.randomUUID()}`;

    // Mint the capability token the chrome extension would have
    // received from the native messaging pair flow. No JWT is minted
    // anywhere in this test — the `/v1/browser-relay` upgrade handler
    // must accept this token directly.
    const { token } = mintHostBrowserCapability(guardianId);

    const { createMockChromeExtension } =
      await import("./fixtures/mock-chrome-extension.js");
    // WS result transport: the extension returns results over the same
    // `/v1/browser-relay` WebSocket it received the request on. This
    // is the canonical self-hosted return path when the socket is
    // healthy.
    const mockExt = createMockChromeExtension({
      runtimeBaseUrl,
      token,
      resultTransport: "ws",
    });
    await mockExt.start();
    await mockExt.waitForConnection();

    // Give the open handler a tick to register the connection in the
    // ChromeExtensionRegistry. If the capability-token branch of the
    // upgrade handler is broken, waitForRegistryEntry() will throw
    // before the Browser.getVersion call runs.
    await waitForRegistryEntry(guardianId);

    const { proxy } = createBoundProxy(guardianId, "conv-cap-happy-ws");

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

    proxy.dispose();
    await mockExt.stop();
  });

  test("capability token round-trips Browser.getVersion over HTTP POST fallback", async () => {
    // HTTP result transport: the extension POSTs results back to
    // `/v1/host-browser-result` with the same capability token used
    // for the WS handshake. This exercises the capability-token-aware
    // auth on the POST route and proves the HTTP fallback path
    // resolves the pending interaction end-to-end.
    const guardianId = `self-hosted-guardian-${crypto.randomUUID()}`;
    const { token } = mintHostBrowserCapability(guardianId);

    const { createMockChromeExtension } =
      await import("./fixtures/mock-chrome-extension.js");
    const mockExt = createMockChromeExtension({
      runtimeBaseUrl,
      token,
      resultTransport: "http",
    });
    await mockExt.start();
    await mockExt.waitForConnection();
    await waitForRegistryEntry(guardianId);

    const { proxy } = createBoundProxy(guardianId, "conv-cap-happy-http");

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

    proxy.dispose();
    await mockExt.stop();
  });

  test("an invalid capability token is rejected with 401", async () => {
    // Sanity check: the capability branch must not be a rubber stamp
    // — a malformed token should still 401 the upgrade. If this ever
    // starts passing on a junk token the self-hosted security
    // posture has regressed.
    const { createMockChromeExtension } =
      await import("./fixtures/mock-chrome-extension.js");
    const mockExt = createMockChromeExtension({
      runtimeBaseUrl,
      token: "not-a-real-token.xxxxxxxxxxxxx",
    });
    await mockExt.start();
    // The upgrade will fail; waitForConnection will time out. We
    // intentionally give it a short window and swallow the timeout.
    let connected = false;
    try {
      await mockExt.waitForConnection(500);
      connected = true;
    } catch {
      // expected
    }
    expect(connected).toBe(false);
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
  guardianId: string,
  timeoutMs = 2000,
): Promise<void> {
  await waitFor(
    () => getChromeExtensionRegistry().get(guardianId) !== undefined,
    timeoutMs,
  );
}
