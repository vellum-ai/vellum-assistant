/**
 * End-to-end WebSocket dispatch test for the PR10 envelopes:
 *
 *   - `host_browser_event` — the extension forwards every
 *     `chrome.debugger.onEvent` firing to the runtime over the
 *     browser-relay WebSocket. This test asserts that the runtime's
 *     inbound frame handler fans the event out to subscribers of the
 *     module-level browser-session event bus with the method + params
 *     + cdpSessionId preserved.
 *
 *   - `host_browser_session_invalidated` — the extension forwards a
 *     detach notification over the same socket. This test asserts
 *     that the runtime-side `BrowserSessionManager` evicts any stale
 *     session whose `targetId` matches the invalidated envelope and
 *     that the next CDP command against that session throws, forcing
 *     the owning tool to create a fresh session (which in production
 *     triggers a reattach on the extension's dispatcher).
 *
 * Unlike the unit test in `host-browser-event-routes.test.ts`, this
 * file stands up the full `RuntimeHttpServer` so the WS upgrade,
 * frame parse, dispatch switch, and resolver helpers all run through
 * their production code paths. The capability-token transport is
 * used so the test does not depend on a valid guardian-bound JWT.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ── Module mocks (must be declared before the real imports below) ───

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

import {
  __resetBrowserSessionEventsForTests,
  BrowserSessionManager,
  createExtensionBackend,
  type ForwardedCdpEvent,
  onCdpEvent,
} from "../browser-session/index.js";
import { getDb, initializeDb } from "../memory/db.js";
import { mintHostBrowserCapability } from "../runtime/capability-tokens.js";
import {
  __resetChromeExtensionRegistryForTests,
  getChromeExtensionRegistry,
} from "../runtime/chrome-extension-registry.js";
import { RuntimeHttpServer } from "../runtime/http-server.js";
import * as pendingInteractions from "../runtime/pending-interactions.js";

initializeDb();

// ── Helpers ─────────────────────────────────────────────────────────

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

// ── Tests ───────────────────────────────────────────────────────────

describe("host_browser WS event + invalidation e2e", () => {
  let server: RuntimeHttpServer;
  let port: number;
  let runtimeBaseUrl: string;

  beforeEach(async () => {
    const db = getDb();
    db.run("DELETE FROM contact_channels");
    db.run("DELETE FROM contacts");
    pendingInteractions.clear();
    __resetChromeExtensionRegistryForTests();
    __resetBrowserSessionEventsForTests();

    // Pick a non-colliding port in the same band as the other
    // host-browser e2e tests but offset so parallel runs don't
    // step on one another.
    port = 19900 + Math.floor(Math.random() * 200);
    runtimeBaseUrl = `http://127.0.0.1:${port}`;
    server = new RuntimeHttpServer({ port });
    await server.start();
  });

  afterEach(async () => {
    await server?.stop();
    pendingInteractions.clear();
    __resetChromeExtensionRegistryForTests();
    __resetBrowserSessionEventsForTests();
  });

  test("host_browser_event frame fans out to browser-session event bus subscribers", async () => {
    const guardianId = `guardian-${crypto.randomUUID()}`;
    const { token } = mintHostBrowserCapability(guardianId);

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

    // Subscribe BEFORE sending the frame so we're guaranteed to see
    // the fanout. The subscription is module-level so it survives
    // across the WS round-trip naturally.
    const observed: ForwardedCdpEvent[] = [];
    const unsubscribe = onCdpEvent((event) => observed.push(event));

    mockExt.sendHostBrowserEvent({
      method: "Page.frameNavigated",
      params: { frame: { id: "frame-1", url: "https://example.com" } },
      cdpSessionId: "target-abc",
    });

    // The WS dispatch hop is asynchronous — poll until the event
    // lands or the test times out.
    await waitFor(() => observed.length === 1);

    expect(observed[0].method).toBe("Page.frameNavigated");
    expect(observed[0].params).toEqual({
      frame: { id: "frame-1", url: "https://example.com" },
    });
    expect(observed[0].cdpSessionId).toBe("target-abc");

    unsubscribe();
    await mockExt.stop();
  });

  test("host_browser_event frames with no params are still routed", async () => {
    const guardianId = `guardian-${crypto.randomUUID()}`;
    const { token } = mintHostBrowserCapability(guardianId);

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

    const observed: ForwardedCdpEvent[] = [];
    const unsubscribe = onCdpEvent((event) => observed.push(event));

    mockExt.sendHostBrowserEvent({ method: "Target.targetDestroyed" });

    await waitFor(() => observed.length === 1);
    expect(observed[0].method).toBe("Target.targetDestroyed");
    expect(observed[0].params).toBeUndefined();
    expect(observed[0].cdpSessionId).toBeUndefined();

    unsubscribe();
    await mockExt.stop();
  });

  test("host_browser_session_invalidated frame evicts stale sessions and the next command forces reattach", async () => {
    const guardianId = `guardian-${crypto.randomUUID()}`;
    const { token } = mintHostBrowserCapability(guardianId);

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

    // Stand up a BrowserSessionManager that mirrors what a tool
    // invocation would build. The backend counts dispatch attempts
    // so we can assert the first post-invalidation send never
    // reached the backend while the second (after reattach) did.
    const sent: Array<{ method: string }> = [];
    const backend = createExtensionBackend({
      isAvailable: () => true,
      sendCdp: async (command) => {
        sent.push({ method: command.method });
        return { result: { ok: true } };
      },
      dispose: () => {},
    });
    const manager = new BrowserSessionManager({ backends: [backend] });
    const session = manager.createSession();
    session.targetId = "tab-77";

    // Fire the invalidation envelope from the extension side.
    mockExt.sendSessionInvalidated({
      targetId: "tab-77",
      reason: "target_closed",
    });

    // Wait until the WS dispatch hop lands — `isTargetInvalidated`
    // peeks at the registry without consuming the entry, so we can
    // poll safely.
    const { isTargetInvalidated } =
      await import("../browser-session/events.js");
    await waitFor(() => isTargetInvalidated("tab-77"));

    // The next send against the invalidated session MUST throw —
    // the manager consumes the invalidation flag, evicts the
    // session, and rejects the command so the caller can create a
    // fresh session (which triggers a reattach on the extension
    // side).
    await expect(
      manager.send(session.id, { method: "Page.navigate" }),
    ).rejects.toThrow(/invalidated/);

    // Sanity: the backend never saw the doomed command.
    expect(sent).toHaveLength(0);

    // The evicted session is gone — sending again throws
    // "Unknown browser session", which is the signal a tool uses
    // to rebuild a fresh session.
    await expect(
      manager.send(session.id, { method: "Page.navigate" }),
    ).rejects.toThrow(/Unknown browser session/);

    // Creating a fresh session proves the reattach path works:
    // the caller bounces through `createSession` and a subsequent
    // send dispatches normally through the backend.
    const fresh = manager.createSession();
    const result = await manager.send(fresh.id, {
      method: "Page.navigate",
    });
    expect(result.result).toEqual({ ok: true });
    expect(sent).toEqual([{ method: "Page.navigate" }]);

    await mockExt.stop();
  });

  test("keepalive frames are accepted without closing the socket or producing warnings", async () => {
    const guardianId = `guardian-${crypto.randomUUID()}`;
    const { token } = mintHostBrowserCapability(guardianId);

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

    // Grab the initial lastActiveAt timestamp so we can verify it
    // was bumped by the keepalive.
    const connBefore = getChromeExtensionRegistry().get(guardianId)!;
    const lastActiveBefore = connBefore.lastActiveAt;

    // Small delay to ensure Date.now() advances at least 1ms.
    await new Promise((r) => setTimeout(r, 15));

    // Send a keepalive frame (the extension sends these periodically
    // to prevent the runtime from considering the connection stale).
    // The frame may contain extra keys (e.g. timestamp) that the
    // runtime should silently ignore (lenient validation).
    mockExt.sendRaw(JSON.stringify({ type: "keepalive", ts: Date.now() }));

    // Wait for the touch to propagate.
    await waitFor(() => {
      const conn = getChromeExtensionRegistry().get(guardianId);
      return conn !== undefined && conn.lastActiveAt > lastActiveBefore;
    });

    const connAfter = getChromeExtensionRegistry().get(guardianId)!;
    expect(connAfter.lastActiveAt).toBeGreaterThan(lastActiveBefore);

    // Verify the socket is still alive by sending a normal host_browser_event
    // frame after the keepalive — if the socket had been torn down, this
    // would never arrive.
    const observed: ForwardedCdpEvent[] = [];
    const unsubscribe = onCdpEvent((event) => observed.push(event));

    mockExt.sendHostBrowserEvent({ method: "Page.loadEventFired" });
    await waitFor(() => observed.length === 1);
    expect(observed[0].method).toBe("Page.loadEventFired");

    unsubscribe();
    await mockExt.stop();
  });

  test("normal host_browser flows still pass after keepalive traffic", async () => {
    const guardianId = `guardian-${crypto.randomUUID()}`;
    const { token } = mintHostBrowserCapability(guardianId);

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

    // Simulate a burst of keepalive frames (as would happen during an
    // idle period with the extension's alarm-based keepalive ticker).
    for (let i = 0; i < 5; i++) {
      mockExt.sendRaw(JSON.stringify({ type: "keepalive" }));
    }

    // Small delay to let all keepalive frames process.
    await new Promise((r) => setTimeout(r, 50));

    // Now send a host_browser_event and verify it still fans out
    // correctly — proving keepalive traffic does not interfere with
    // normal message processing.
    const observed: ForwardedCdpEvent[] = [];
    const unsubscribe = onCdpEvent((event) => observed.push(event));

    mockExt.sendHostBrowserEvent({
      method: "Network.requestWillBeSent",
      params: { requestId: "req-42", url: "https://example.com/api" },
      cdpSessionId: "session-xyz",
    });

    await waitFor(() => observed.length === 1);
    expect(observed[0].method).toBe("Network.requestWillBeSent");
    expect(observed[0].params).toEqual({
      requestId: "req-42",
      url: "https://example.com/api",
    });
    expect(observed[0].cdpSessionId).toBe("session-xyz");

    unsubscribe();
    await mockExt.stop();
  });

  test("malformed host_browser_event frames are dropped without tearing down the socket", async () => {
    const guardianId = `guardian-${crypto.randomUUID()}`;
    const { token } = mintHostBrowserCapability(guardianId);

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

    const observed: ForwardedCdpEvent[] = [];
    const unsubscribe = onCdpEvent((event) => observed.push(event));

    // Send a frame with no method — the resolver must reject it
    // and the WS dispatcher must swallow the rejection.
    mockExt.sendHostBrowserEvent({ method: "" });

    // Follow up with a valid frame and assert that ONLY the valid
    // frame was published — proving the socket survived the bad
    // frame and the dispatcher kept processing subsequent messages.
    mockExt.sendHostBrowserEvent({ method: "Page.loadEventFired" });

    await waitFor(() => observed.length === 1);
    expect(observed[0].method).toBe("Page.loadEventFired");

    unsubscribe();
    await mockExt.stop();
  });
});
