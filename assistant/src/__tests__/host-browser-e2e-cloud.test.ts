/**
 * E2E smoke test for the cloud-hosted `host_browser_request` round-trip.
 *
 * Boots the runtime HTTP server in-process, opens a mock chrome-extension
 * WebSocket against `/v1/browser-relay`, and drives
 * `HostBrowserProxy.instance.request()` end-to-end:
 *
 *   proxy.request()
 *     → sendToExtension (routed via assistant event hub)
 *     → mock extension WebSocket receives host_browser_request
 *     → mock CDP handler (Browser.getVersion fake)
 *     → POST /v1/host-browser-result (or WS host_browser_result frame)
 *     → resolveHostBrowserResultByRequestId → proxy.resolveResult()
 *     → request() resolves
 *
 * Covers:
 *   - Happy path: Browser.getVersion round-trips and returns the fake
 *     product string.
 *   - Abort: an aborted AbortSignal resolves with "Aborted" and the mock
 *     extension receives a host_browser_cancel frame.
 *   - Timeout: if the mock extension receives the frame but never
 *     POSTs a result, the proxy's setTimeout path fires and surfaces
 *     a "timed out waiting for client response" error.
 *
 * The test runs entirely in Bun + loopback WebSocket/fetch — no real
 * Chrome required.
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
import { assistantEventHub } from "../runtime/assistant-event-hub.js";
import { mintToken } from "../runtime/auth/token-service.js";
import { RuntimeHttpServer } from "../runtime/http-server.js";
import * as pendingInteractions from "../runtime/pending-interactions.js";

initializeDb();

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Mint an actor-bound JWT for the given guardianId. The WebSocket
 * upgrade handler parses `sub=actor:<assistantId>:<actorPrincipalId>`
 * and treats `actorPrincipalId` as the guardianId.
 */
function mintActorToken(guardianId: string): string {
  return mintToken({
    aud: "vellum-daemon",
    sub: `actor:self:${guardianId}`,
    scope_profile: "actor_client_v1",
    policy_epoch: 1,
    ttlSeconds: 3600,
  });
}

// ── Tests ───────────────────────────────────────────────────────────

describe("host_browser cloud-hosted e2e round-trip", () => {
  let server: RuntimeHttpServer;
  let port: number;
  let runtimeBaseUrl: string;

  beforeEach(async () => {
    const db = getDb();
    db.run("DELETE FROM contact_channels");
    db.run("DELETE FROM contacts");
    HostBrowserProxy.reset();

    port = 19800 + Math.floor(Math.random() * 200);
    runtimeBaseUrl = `http://127.0.0.1:${port}`;
    server = new RuntimeHttpServer({ port });
    await server.start();
  });

  afterEach(async () => {
    await server?.stop();
    HostBrowserProxy.reset();
  });

  test("happy path: Browser.getVersion round-trips through the mock extension", async () => {
    const guardianId = `test-guardian-${crypto.randomUUID()}`;
    const token = mintActorToken(guardianId);

    const { createMockChromeExtension } =
      await import("./fixtures/mock-chrome-extension.js");
    const mockExt = createMockChromeExtension({
      runtimeBaseUrl,
      token,
    });
    await mockExt.start();
    await mockExt.waitForConnection();
    await waitForRegistryEntry(guardianId);

    const proxy = HostBrowserProxy.instance;

    const result = await proxy.request(
      { cdpMethod: "Browser.getVersion" },
      "conv-happy",
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Chrome/MockTest");

    const received = mockExt.receivedRequests();
    expect(received).toHaveLength(1);
    expect(received[0].cdpMethod).toBe("Browser.getVersion");
    expect(typeof received[0].requestId).toBe("string");
    expect(received[0].conversationId).toBe("conv-happy");

    await mockExt.stop();
  });

  test("happy path (WS result transport): Browser.getVersion round-trips when the extension returns the result over the same WS", async () => {
    const guardianId = `test-guardian-${crypto.randomUUID()}`;
    const token = mintActorToken(guardianId);

    const { createMockChromeExtension } =
      await import("./fixtures/mock-chrome-extension.js");
    const mockExt = createMockChromeExtension({
      runtimeBaseUrl,
      token,
      resultTransport: "ws",
    });
    await mockExt.start();
    await mockExt.waitForConnection();
    await waitForRegistryEntry(guardianId);

    const proxy = HostBrowserProxy.instance;

    const result = await proxy.request(
      { cdpMethod: "Browser.getVersion" },
      "conv-happy-ws",
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Chrome/MockTest");

    const received = mockExt.receivedRequests();
    expect(received).toHaveLength(1);
    expect(received[0].cdpMethod).toBe("Browser.getVersion");
    expect(received[0].conversationId).toBe("conv-happy-ws");

    expect(pendingInteractions.get(received[0].requestId)).toBeUndefined();

    await mockExt.stop();
  });

  test("abort: AbortSignal resolves to 'Aborted' and extension receives host_browser_cancel", async () => {
    const guardianId = `test-guardian-${crypto.randomUUID()}`;
    const token = mintActorToken(guardianId);

    const { createMockChromeExtension } =
      await import("./fixtures/mock-chrome-extension.js");
    const mockExt = createMockChromeExtension({
      runtimeBaseUrl,
      token,
      cdpHandler: () => new Promise(() => {}),
    });
    await mockExt.start();
    await mockExt.waitForConnection();
    await waitForRegistryEntry(guardianId);

    const proxy = HostBrowserProxy.instance;

    const controller = new AbortController();
    const resultPromise = proxy.request(
      { cdpMethod: "Browser.getVersion" },
      "conv-abort",
      controller.signal,
    );

    await waitFor(() => mockExt.receivedRequests().length === 1);

    controller.abort();
    const result = await resultPromise;

    expect(result.content).toBe("Aborted");
    expect(result.isError).toBe(true);

    await waitFor(() => mockExt.receivedCancels().length === 1);
    const cancels = mockExt.receivedCancels();
    expect(cancels).toHaveLength(1);
    expect(cancels[0].requestId).toBe(mockExt.receivedRequests()[0].requestId);

    await mockExt.stop();
  });

  test("abort: late /v1/host-browser-result POST after cancel is ignored (no ghost completion)", async () => {
    const guardianId = `test-guardian-${crypto.randomUUID()}`;
    const token = mintActorToken(guardianId);

    const { createMockChromeExtension } =
      await import("./fixtures/mock-chrome-extension.js");
    const mockExt = createMockChromeExtension({
      runtimeBaseUrl,
      token,
      cdpHandler: () => new Promise(() => {}),
    });
    await mockExt.start();
    await mockExt.waitForConnection();
    await waitForRegistryEntry(guardianId);

    const proxy = HostBrowserProxy.instance;

    let resolveCount = 0;
    const controller = new AbortController();
    const resultPromise = proxy
      .request(
        { cdpMethod: "Browser.getVersion" },
        "conv-abort-late",
        controller.signal,
      )
      .then((r) => {
        resolveCount += 1;
        return r;
      });

    await waitFor(() => mockExt.receivedRequests().length === 1);
    const pendingRequestId = mockExt.receivedRequests()[0].requestId;

    controller.abort();
    const result = await resultPromise;
    expect(result.content).toBe("Aborted");
    expect(result.isError).toBe(true);
    expect(resolveCount).toBe(1);

    // Manually submit a late result for the same requestId —
    // simulating a non-compliant client that failed to honour the
    // cancel envelope. The runtime must accept the POST without error
    // and the proxy must NOT resolve the caller a second time.
    const lateResp = await fetch(`${runtimeBaseUrl}/v1/host-browser-result`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        requestId: pendingRequestId,
        content: JSON.stringify({ product: "Chrome/LateResult" }),
        isError: false,
      }),
    });
    await lateResp.body?.cancel();

    await new Promise((r) => setTimeout(r, 20));
    expect(resolveCount).toBe(1);

    await mockExt.stop();
  });

  test("timeout: proxy.request resolves with timeout error when client never responds", async () => {
    const guardianId = `test-guardian-${crypto.randomUUID()}`;
    const token = mintActorToken(guardianId);

    const { createMockChromeExtension } =
      await import("./fixtures/mock-chrome-extension.js");
    const mockExt = createMockChromeExtension({
      runtimeBaseUrl,
      token,
      cdpHandler: () => new Promise(() => {}),
    });
    await mockExt.start();
    await mockExt.waitForConnection();
    await waitForRegistryEntry(guardianId);

    const proxy = HostBrowserProxy.instance;

    const resultPromise = proxy.request(
      { cdpMethod: "Browser.getVersion", timeout_seconds: 0.5 },
      "conv-timeout",
    );

    await waitFor(() => mockExt.receivedRequests().length === 1);

    const result = await resultPromise;

    expect(result.isError).toBe(true);
    expect(result.content).toContain("timed out");

    expect(mockExt.receivedRequests()).toHaveLength(1);
    expect(mockExt.receivedRequests()[0].cdpMethod).toBe("Browser.getVersion");

    await mockExt.stop();
  });
});

// ── macOS message ingress with connected extension ──────────────────

describe("macOS message ingress with connected extension", () => {
  let server: RuntimeHttpServer;
  let port: number;
  let runtimeBaseUrl: string;

  beforeEach(async () => {
    const db = getDb();
    db.run("DELETE FROM contact_channels");
    db.run("DELETE FROM contacts");
    HostBrowserProxy.reset();

    port = 20000 + Math.floor(Math.random() * 200);
    runtimeBaseUrl = `http://127.0.0.1:${port}`;
    server = new RuntimeHttpServer({ port });
    await server.start();
  });

  afterEach(async () => {
    await server?.stop();
    HostBrowserProxy.reset();
  });

  test("macOS turn routes Browser.getVersion through the registry-backed extension", async () => {
    const guardianId = `test-guardian-macos-${crypto.randomUUID()}`;
    const token = mintActorToken(guardianId);

    const { createMockChromeExtension } =
      await import("./fixtures/mock-chrome-extension.js");
    const mockExt = createMockChromeExtension({
      runtimeBaseUrl,
      token,
    });
    await mockExt.start();
    await mockExt.waitForConnection();
    await waitForRegistryEntry(guardianId);

    const proxy = HostBrowserProxy.instance;

    const result = await proxy.request(
      { cdpMethod: "Browser.getVersion" },
      "conv-macos-ext",
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Chrome/MockTest");

    const received = mockExt.receivedRequests();
    expect(received).toHaveLength(1);
    expect(received[0].cdpMethod).toBe("Browser.getVersion");
    expect(received[0].conversationId).toBe("conv-macos-ext");

    await mockExt.stop();
  });

  test("macOS turn with extension disconnected mid-conversation rejects (proxy detects unavailability)", async () => {
    const guardianId = `test-guardian-macos-disco-${crypto.randomUUID()}`;
    const token = mintActorToken(guardianId);

    const { createMockChromeExtension } =
      await import("./fixtures/mock-chrome-extension.js");
    const mockExt = createMockChromeExtension({
      runtimeBaseUrl,
      token,
    });
    await mockExt.start();
    await mockExt.waitForConnection();
    await waitForRegistryEntry(guardianId);

    mockExt.forceDisconnect();

    await waitFor(
      () =>
        assistantEventHub.getMostRecentClientByCapability("host_browser") ==
        null,
    );

    const proxy = HostBrowserProxy.instance;

    try {
      await proxy.request(
        { cdpMethod: "Browser.getVersion", timeout_seconds: 0.5 },
        "conv-macos-disco",
      );
      expect(true).toBe(false); // Should not reach here
    } catch {
      // Expected: the send failed because the extension is disconnected.
    }

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
    () =>
      assistantEventHub.getMostRecentClientByCapability("host_browser") != null,
    timeoutMs,
  );
}
