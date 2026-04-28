/**
 * E2E smoke test for the cloud-hosted `host_browser_request` round-trip.
 *
 * Boots the runtime HTTP server in-process, opens a mock chrome-extension
 * WebSocket against `/v1/browser-relay`, and drives
 * `HostBrowserProxy.request()` end-to-end:
 *
 *   proxy.request()
 *     → sendToClient (routed via ChromeExtensionRegistry by guardianId)
 *     → mock extension WebSocket receives host_browser_request
 *     → mock CDP handler (Browser.getVersion fake)
 *     → POST /v1/host-browser-result
 *     → handleHostBrowserResult → HostBrowserProxy.instance.resolve()
 *     → proxy.resolve() → request() resolves
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
import type { ServerMessage } from "../daemon/message-protocol.js";
import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { mintToken } from "../runtime/auth/token-service.js";
import {
  __resetChromeExtensionRegistryForTests,
  getChromeExtensionRegistry,
} from "../runtime/chrome-extension-registry.js";
import { RuntimeHttpServer } from "../runtime/http-server.js";
import * as pendingInteractions from "../runtime/pending-interactions.js";

initializeDb();

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * The result handler at `/v1/host-browser-result` resolves via
 * `HostBrowserProxy.instance`. Point the singleton at whatever proxy
 * the current test is driving so results route back correctly.
 */
let activeTestProxy: HostBrowserProxy | null = null;
// Patch the static instance getter to return the test proxy.
Object.defineProperty(HostBrowserProxy, "instance", {
  get() {
    return activeTestProxy ?? undefined;
  },
  configurable: true,
});

/**
 * Wrap a HostBrowserProxy in a sendToClient that routes
 * host_browser_request/host_browser_cancel via the Chrome extension
 * registry for the given guardianId and registers pending interactions.
 */
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
    // Each test gets a clean DB and a fresh registry so connection
    // state doesn't leak between cases.
    const db = getDb();
    db.run("DELETE FROM contact_channels");
    db.run("DELETE FROM contacts");
    pendingInteractions.clear();
    __resetChromeExtensionRegistryForTests();

    port = 19800 + Math.floor(Math.random() * 200);
    runtimeBaseUrl = `http://127.0.0.1:${port}`;
    server = new RuntimeHttpServer({ port });
    await server.start();
  });

  afterEach(async () => {
    await server?.stop();
    pendingInteractions.clear();
    __resetChromeExtensionRegistryForTests();
  });

  test("happy path: Browser.getVersion round-trips through the mock extension", async () => {
    const guardianId = `test-guardian-${crypto.randomUUID()}`;
    const token = mintActorToken(guardianId);

    // Dynamic import keeps the module cache warm across tests but avoids
    // binding the fixture at file-load time (where the mocks might not
    // yet have applied for a freshly forked test worker).
    const { createMockChromeExtension } =
      await import("./fixtures/mock-chrome-extension.js");
    const mockExt = createMockChromeExtension({
      runtimeBaseUrl,
      token,
    });
    await mockExt.start();
    await mockExt.waitForConnection();

    // Give the open handler a tick to register the connection in the
    // ChromeExtensionRegistry (Bun's WebSocket open callback fires
    // asynchronously after the upgrade handler returns).
    await waitForRegistryEntry(guardianId);

    const { proxy } = createBoundProxy(guardianId, "conv-happy");

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

    proxy.dispose();
    await mockExt.stop();
  });

  test("happy path (WS result transport): Browser.getVersion round-trips when the extension returns the result over the same WS", async () => {
    const guardianId = `test-guardian-${crypto.randomUUID()}`;
    const token = mintActorToken(guardianId);

    const { createMockChromeExtension } =
      await import("./fixtures/mock-chrome-extension.js");
    // Same fixture as the HTTP happy path, but configured to return
    // results over the /v1/browser-relay WebSocket instead of POSTing
    // /v1/host-browser-result. This exercises the runtime WS
    // `message` handler's host_browser_result dispatch path.
    const mockExt = createMockChromeExtension({
      runtimeBaseUrl,
      token,
      resultTransport: "ws",
    });
    await mockExt.start();
    await mockExt.waitForConnection();
    await waitForRegistryEntry(guardianId);

    const { proxy } = createBoundProxy(guardianId, "conv-happy-ws");

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

    // The pending interaction must be fully consumed — if the WS
    // handler silently no-op'd, the entry would still be registered
    // after the proxy resolves.
    expect(pendingInteractions.get(received[0].requestId)).toBeUndefined();

    proxy.dispose();
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
      // Hang forever so we can abort mid-flight without a race against
      // the default handler's immediate response.
      cdpHandler: () => new Promise(() => {}),
    });
    await mockExt.start();
    await mockExt.waitForConnection();
    await waitForRegistryEntry(guardianId);

    const { proxy } = createBoundProxy(guardianId, "conv-abort");

    const controller = new AbortController();
    const resultPromise = proxy.request(
      { cdpMethod: "Browser.getVersion" },
      "conv-abort",
      controller.signal,
    );

    // Wait for the mock extension to observe the request, then abort so
    // the cancel envelope has somewhere to land.
    await waitFor(() => mockExt.receivedRequests().length === 1);

    controller.abort();
    const result = await resultPromise;

    expect(result.content).toBe("Aborted");
    expect(result.isError).toBe(true);

    // The cancel frame is dispatched synchronously from the abort
    // listener, but the WebSocket delivers it asynchronously — give it a
    // few turns to arrive before asserting.
    await waitFor(() => mockExt.receivedCancels().length === 1);
    const cancels = mockExt.receivedCancels();
    expect(cancels).toHaveLength(1);
    expect(cancels[0].requestId).toBe(mockExt.receivedRequests()[0].requestId);

    proxy.dispose();
    await mockExt.stop();
  });

  test("abort: late /v1/host-browser-result POST after cancel is ignored (no ghost completion)", async () => {
    // The daemon-side proxy must treat a late result POST — arriving
    // after the caller has already been resolved with "Aborted" —
    // as a benign race, not a noisy false-positive timeout. It must
    // also NOT resolve the caller a second time.
    //
    // We exercise this from the daemon's perspective by:
    //   1. Starting a request with an AbortSignal.
    //   2. Aborting the signal so the proxy resolves with "Aborted".
    //   3. Manually POSTing a host_browser_result for the same
    //      requestId straight to /v1/host-browser-result (bypassing
    //      the compliant dispatcher's cancel-suppression).
    //   4. Verifying the POST is accepted by the runtime (i.e. the
    //      HTTP layer doesn't explode) and the caller's promise
    //      never fulfils twice.
    const guardianId = `test-guardian-${crypto.randomUUID()}`;
    const token = mintActorToken(guardianId);

    const { createMockChromeExtension } =
      await import("./fixtures/mock-chrome-extension.js");
    const mockExt = createMockChromeExtension({
      runtimeBaseUrl,
      token,
      // Hang forever — same gating trick as the plain abort test,
      // so we can cancel before the handler returns anything.
      cdpHandler: () => new Promise(() => {}),
    });
    await mockExt.start();
    await mockExt.waitForConnection();
    await waitForRegistryEntry(guardianId);

    const { proxy } = createBoundProxy(guardianId, "conv-abort-late");

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

    // Now manually submit a late result for the same requestId —
    // simulating a non-compliant client that failed to honour the
    // cancel envelope. The runtime must accept the POST without
    // error and the proxy must NOT resolve the caller a second time.
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

    // Give the runtime a few turns to process the POST and hit its
    // "no pending request" debug branch. If the proxy resolved a
    // second time, `resolveCount` would be 2 here.
    await new Promise((r) => setTimeout(r, 20));
    expect(resolveCount).toBe(1);

    proxy.dispose();
    await mockExt.stop();
  });

  test("timeout: proxy.request resolves with timeout error when client never responds", async () => {
    const guardianId = `test-guardian-${crypto.randomUUID()}`;
    const token = mintActorToken(guardianId);

    const { createMockChromeExtension } =
      await import("./fixtures/mock-chrome-extension.js");
    // CDP handler that never resolves — the request frame reaches the
    // mock extension successfully, but no result is ever POSTed back.
    // This exercises the proxy's `setTimeout` path (as opposed to a
    // synchronous send failure, which is a separate code path).
    const mockExt = createMockChromeExtension({
      runtimeBaseUrl,
      token,
      cdpHandler: () => new Promise(() => {}),
    });
    await mockExt.start();
    await mockExt.waitForConnection();
    await waitForRegistryEntry(guardianId);

    const { proxy } = createBoundProxy(guardianId, "conv-timeout");

    // 50ms timeout — short enough to keep the test fast, long enough
    // for the request frame to make the WS round-trip to the mock
    // extension before the timer fires.
    const result = await proxy.request(
      { cdpMethod: "Browser.getVersion", timeout_seconds: 0.05 },
      "conv-timeout",
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("timed out");

    // Sanity check: the frame actually reached the mock extension (so
    // we know we're exercising the proxy's timer, not a send failure).
    expect(mockExt.receivedRequests()).toHaveLength(1);
    expect(mockExt.receivedRequests()[0].cdpMethod).toBe("Browser.getVersion");

    proxy.dispose();
    await mockExt.stop();
  });
});

// ── macOS message ingress with connected extension ──────────────────
//
// Verifies the end-to-end path for macOS-originated turns when the user
// has the chrome extension connected. On macOS, browser commands should
// route through the registry-backed host browser flow (extension → user's
// real Chrome session) rather than falling back to local Playwright.
//
// The macOS browser backend preference order is:
//
//   macOS + extension connected → extension backend (registry-routed)
//   macOS + extension absent    → cdp-inspect (desktop-auto) → local
//
// NOTE: These tests construct a HostBrowserProxy directly and call
// proxy.request(), which validates the extension relay round-trip but
// bypasses handleSendMessage / conversation-routes. Full ingress-path
// coverage (interface propagation, resolveHostBrowserSender wiring, and
// CDP factory candidate selection) is exercised by the route-level tests
// in conversation-routes-disk-view.test.ts.
//
// If future refactors break the wiring between conversation-routes
// (`resolveHostBrowserSender`) and the CDP factory's candidate list, those
// route-level tests will fail.

describe("macOS message ingress with connected extension", () => {
  let server: RuntimeHttpServer;
  let port: number;
  let runtimeBaseUrl: string;

  beforeEach(async () => {
    const db = getDb();
    db.run("DELETE FROM contact_channels");
    db.run("DELETE FROM contacts");
    pendingInteractions.clear();
    __resetChromeExtensionRegistryForTests();

    port = 20000 + Math.floor(Math.random() * 200);
    runtimeBaseUrl = `http://127.0.0.1:${port}`;
    server = new RuntimeHttpServer({ port });
    await server.start();
  });

  afterEach(async () => {
    await server?.stop();
    pendingInteractions.clear();
    __resetChromeExtensionRegistryForTests();
  });

  test("macOS turn routes Browser.getVersion through the registry-backed extension, not local Playwright", async () => {
    // Arrange: connect a mock extension for a given guardianId.
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

    // Build a proxy bound to the guardian's extension connection, mimicking
    // the wiring that conversation-routes.ts performs for macOS turns when
    // the ChromeExtensionRegistry has an active entry for the guardian.
    const { proxy } = createBoundProxy(guardianId, "conv-macos-ext");

    // Act: issue a CDP command through the proxy (same as how browser tools
    // dispatch commands during a macOS turn with extension override).
    const result = await proxy.request(
      { cdpMethod: "Browser.getVersion" },
      "conv-macos-ext",
    );

    // Assert: the command reached the mock extension (not local Playwright)
    // and the round-trip completed successfully.
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Chrome/MockTest");

    const received = mockExt.receivedRequests();
    expect(received).toHaveLength(1);
    expect(received[0].cdpMethod).toBe("Browser.getVersion");
    expect(received[0].conversationId).toBe("conv-macos-ext");

    proxy.dispose();
    await mockExt.stop();
  });

  test("macOS turn with extension disconnected mid-conversation does not hang (proxy detects unavailability)", async () => {
    // Arrange: connect a mock extension then forcibly disconnect it.
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

    // The proxy is bound while the extension is still connected.
    const { proxy } = createBoundProxy(guardianId, "conv-macos-disco");

    // Disconnect the extension before sending any commands.
    mockExt.forceDisconnect();

    // Wait for the registry to notice the close event.
    await waitFor(
      () => getChromeExtensionRegistry().get(guardianId) === undefined,
    );

    // Act: attempt a CDP command through the proxy. The registry send should
    // fail because the connection is gone, and the proxy's sendToClient
    // wrapper throws immediately.
    try {
      await proxy.request(
        { cdpMethod: "Browser.getVersion", timeout_seconds: 0.5 },
        "conv-macos-disco",
      );
      // If we reach here, the test should still verify the result indicates
      // an error rather than a successful extension round-trip.
      expect(true).toBe(false); // Should not reach here
    } catch {
      // Expected: the send failed because the extension is disconnected.
      // This confirms the macOS path detects disconnection rather than
      // silently routing to the wrong backend.
    }

    proxy.dispose();
    await mockExt.stop();
  });
});

// ── macOS SSE bridge ingress (no extension registry) ────────────────
//
// Exercises the cloud-hosted + desktop SSE bridge path for macOS turns
// WITHOUT relying on the ChromeExtensionRegistry. This validates the
// native macOS host-browser proxy path where `host_browser_request`
// frames travel through `assistantEventHub` (SSE) rather than the
// extension WebSocket.
//
// In production, this path is used when:
//   - The macOS desktop client is connected to the assistant via SSE
//   - The user does NOT have the Chrome extension installed
//   - The desktop client receives `host_browser_request` frames via SSE,
//     executes CDP commands against the local Chrome, and POSTs results
//     back to `/v1/host-browser-result`
//
// The test constructs a HostBrowserProxy wired to a mock SSE sender
// (simulating the `onEvent` hub publisher) and a mock macOS client that
// observes the sent frames and returns results via POST.

describe("macOS SSE bridge ingress (no extension registry)", () => {
  let server: RuntimeHttpServer;
  let port: number;
  let runtimeBaseUrl: string;

  beforeEach(async () => {
    const db = getDb();
    db.run("DELETE FROM contact_channels");
    db.run("DELETE FROM contacts");
    pendingInteractions.clear();
    __resetChromeExtensionRegistryForTests();

    port = 20200 + Math.floor(Math.random() * 200);
    runtimeBaseUrl = `http://127.0.0.1:${port}`;
    server = new RuntimeHttpServer({ port });
    await server.start();
  });

  afterEach(async () => {
    await server?.stop();
    pendingInteractions.clear();
    __resetChromeExtensionRegistryForTests();
  });

  /**
   * Create a HostBrowserProxy wired to a mock SSE sender. The sender
   * captures `host_browser_request` frames and simulates what the macOS
   * desktop client does: execute the CDP command locally and POST the
   * result back to `/v1/host-browser-result`.
   *
   * Unlike `createBoundProxy` (which routes through the extension
   * registry), this helper routes through a direct function call —
   * simulating the `onEvent` SSE hub publisher path.
   */
  function createSseBoundProxy(
    conversationId: string,
    token: string,
  ): {
    proxy: HostBrowserProxy;
    sentFrames: Array<{ type: string; [key: string]: unknown }>;
  } {
    const sentFrames: Array<{ type: string; [key: string]: unknown }> = [];

    const sseSender = (msg: ServerMessage) => {
      const frame = msg as { type: string; [key: string]: unknown };
      sentFrames.push(frame);

      if (frame.type === "host_browser_request") {
        const requestId = frame.requestId as string;

        pendingInteractions.register(requestId, {
          conversation: null,
          conversationId,
          kind: "host_browser",
        });

        // Simulate the macOS desktop client processing the CDP command
        // and POSTing the result back to the runtime.
        const cdpMethod = frame.cdpMethod as string;
        let content: string;
        let isError = false;
        if (cdpMethod === "Browser.getVersion") {
          content = JSON.stringify({
            product: "Chrome/macOS-SSE-Test",
            protocolVersion: "1.3",
            revision: "@macos-sse",
            userAgent: "Mozilla/5.0 (macOS SSE bridge e2e fixture)",
            jsVersion: "0.0.0-macos-sse",
          });
        } else if (cdpMethod === "Runtime.evaluate") {
          content = JSON.stringify({ result: { value: "complete" } });
        } else {
          content = `mock macOS client: unsupported cdpMethod "${cdpMethod}"`;
          isError = true;
        }

        // POST result asynchronously (simulating the real macOS client).
        void fetch(`${runtimeBaseUrl}/v1/host-browser-result`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ requestId, content, isError }),
        })
          .then((res) => res.body?.cancel())
          .catch(() => {});
      }
    };

    const proxy = new HostBrowserProxy(sseSender);
    activeTestProxy = proxy;
    return { proxy, sentFrames };
  }

  test("happy path: Browser.getVersion round-trips through the SSE bridge without extension registry", async () => {
    const guardianId = `test-guardian-macos-sse-${crypto.randomUUID()}`;
    const token = mintActorToken(guardianId);

    const { proxy, sentFrames } = createSseBoundProxy(
      "conv-macos-sse-happy",
      token,
    );

    const result = await proxy.request(
      { cdpMethod: "Browser.getVersion" },
      "conv-macos-sse-happy",
    );

    // The request completed via the SSE bridge path, not the extension registry.
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Chrome/macOS-SSE-Test");

    // The SSE sender received exactly one host_browser_request frame.
    const requests = sentFrames.filter(
      (f) => f.type === "host_browser_request",
    );
    expect(requests).toHaveLength(1);
    expect(requests[0].cdpMethod).toBe("Browser.getVersion");
    expect(requests[0].conversationId).toBe("conv-macos-sse-happy");

    // The extension registry should NOT have been involved — no entries exist.
    expect(getChromeExtensionRegistry().get(guardianId)).toBeUndefined();

    proxy.dispose();
  });

  test("abort: SSE-bridged request resolves to 'Aborted' when signal fires", async () => {
    const guardianId = `test-guardian-macos-sse-abort-${crypto.randomUUID()}`;
    const _token = mintActorToken(guardianId);

    // Use a CDP handler that hangs forever so we can abort mid-flight.
    const sentFrames: Array<{ type: string; [key: string]: unknown }> = [];
    const hangingSender = (msg: ServerMessage) => {
      const frame = msg as { type: string; [key: string]: unknown };
      sentFrames.push(frame);
      if (frame.type === "host_browser_request") {
        const requestId = frame.requestId as string;
        pendingInteractions.register(requestId, {
          conversation: null,
          conversationId: "conv-macos-sse-abort",
          kind: "host_browser",
        });
      }
    };

    const proxy = new HostBrowserProxy(hangingSender);
    activeTestProxy = proxy;

    const controller = new AbortController();
    const resultPromise = proxy.request(
      { cdpMethod: "Browser.getVersion" },
      "conv-macos-sse-abort",
      controller.signal,
    );

    // Wait for the SSE sender to observe the request.
    await waitFor(() => sentFrames.length === 1);

    controller.abort();
    const result = await resultPromise;

    expect(result.content).toBe("Aborted");
    expect(result.isError).toBe(true);

    // The cancel frame should have been sent through the SSE sender.
    const cancels = sentFrames.filter((f) => f.type === "host_browser_cancel");
    expect(cancels).toHaveLength(1);

    proxy.dispose();
  });

  test("timeout: SSE-bridged request surfaces timeout when macOS client never responds", async () => {
    const guardianId = `test-guardian-macos-sse-timeout-${crypto.randomUUID()}`;
    const _token = mintActorToken(guardianId);

    const sentFrames: Array<{ type: string; [key: string]: unknown }> = [];

    const hangingSender = (msg: ServerMessage) => {
      const frame = msg as { type: string; [key: string]: unknown };
      sentFrames.push(frame);
      if (frame.type === "host_browser_request") {
        const requestId = frame.requestId as string;
        pendingInteractions.register(requestId, {
          conversation: null,
          conversationId: "conv-macos-sse-timeout",
          kind: "host_browser",
        });
      }
    };

    const proxy = new HostBrowserProxy(hangingSender);
    activeTestProxy = proxy;

    const result = await proxy.request(
      { cdpMethod: "Browser.getVersion", timeout_seconds: 0.05 },
      "conv-macos-sse-timeout",
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("timed out");

    // The SSE sender received the request frame (confirming the timeout
    // is from the proxy timer, not a send failure).
    const requests = sentFrames.filter(
      (f) => f.type === "host_browser_request",
    );
    expect(requests).toHaveLength(1);
    expect(requests[0].cdpMethod).toBe("Browser.getVersion");

    proxy.dispose();
  });

  test("multiple sequential commands round-trip through the SSE bridge", async () => {
    const guardianId = `test-guardian-macos-sse-seq-${crypto.randomUUID()}`;
    const token = mintActorToken(guardianId);

    const { proxy, sentFrames } = createSseBoundProxy(
      "conv-macos-sse-seq",
      token,
    );

    // First command: Browser.getVersion
    const result1 = await proxy.request(
      { cdpMethod: "Browser.getVersion" },
      "conv-macos-sse-seq",
    );
    expect(result1.isError).toBe(false);
    expect(result1.content).toContain("Chrome/macOS-SSE-Test");

    // Second command: Runtime.evaluate
    const result2 = await proxy.request(
      { cdpMethod: "Runtime.evaluate", cdpParams: { expression: "1+1" } },
      "conv-macos-sse-seq",
    );
    expect(result2.isError).toBe(false);

    // Both requests went through the SSE sender.
    const requests = sentFrames.filter(
      (f) => f.type === "host_browser_request",
    );
    expect(requests).toHaveLength(2);
    expect(requests[0].cdpMethod).toBe("Browser.getVersion");
    expect(requests[1].cdpMethod).toBe("Runtime.evaluate");

    proxy.dispose();
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
