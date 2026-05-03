/**
 * Tests for the surfaceProxyResolver's app_control_* dispatch branch.
 *
 * Mirrors the structure of cu-unified-flow.test.ts but exercises the
 * sibling branch added for app-control: unavailability when no proxy is
 * attached, end-to-end dispatch through HostAppControlProxy.request, and
 * the local short-circuit for app_control_stop (no client round-trip).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const sentMessages: unknown[] = [];
let mockHasClient = true;

mock.module("../runtime/assistant-event-hub.js", () => ({
  broadcastMessage: (msg: unknown) => sentMessages.push(msg),
  assistantEventHub: {
    getMostRecentClientByCapability: (cap: string) =>
      cap === "host_app_control" && mockHasClient
        ? { id: "mock-client" }
        : null,
  },
}));

mock.module("../runtime/pending-interactions.js", () => ({
  resolve: () => undefined,
  get: () => undefined,
  getByKind: () => [],
  getByConversation: () => [],
  removeByConversation: () => {},
}));

const { surfaceProxyResolver } =
  await import("../daemon/conversation-surfaces.js");
const { HostAppControlProxy, _resetActiveAppControlConversationId } =
  await import("../daemon/host-app-control-proxy.js");
type SurfaceConversationContext =
  import("../daemon/conversation-surfaces.js").SurfaceConversationContext;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal SurfaceConversationContext with an optional
 * hostAppControlProxy. Only the fields required by the app-control routing
 * path are populated.
 */
function buildMockContext(
  hostAppControlProxy?: InstanceType<typeof HostAppControlProxy>,
  conversationId = "test-session",
  setHostAppControlProxy?: (
    proxy: InstanceType<typeof HostAppControlProxy> | undefined,
  ) => void,
): SurfaceConversationContext {
  return {
    conversationId,
    traceEmitter: { emit: () => {} },
    sendToClient: () => {},
    pendingSurfaceActions: new Map(),
    lastSurfaceAction: new Map(),
    surfaceState: new Map(),
    surfaceUndoStacks: new Map(),
    accumulatedSurfaceState: new Map(),
    surfaceActionRequestIds: new Set(),
    currentTurnSurfaces: [],
    hostAppControlProxy,
    setHostAppControlProxy,
    isProcessing: () => false,
    enqueueMessage: () => ({ queued: false, requestId: "r1" }),
    getQueueDepth: () => 0,
    processMessage: async () => "",
    withSurface: async (_id, fn) => fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("surfaceProxyResolver — app-control tool routing", () => {
  beforeEach(() => {
    sentMessages.length = 0;
    mockHasClient = true;
    _resetActiveAppControlConversationId();
  });

  afterEach(() => {
    _resetActiveAppControlConversationId();
  });

  // -------------------------------------------------------------------------
  // Unavailability
  // -------------------------------------------------------------------------

  describe("no app-control proxy attached", () => {
    test("returns isError result when ctx.hostAppControlProxy is undefined", async () => {
      const ctx = buildMockContext(/* no proxy */);

      const result = await surfaceProxyResolver(ctx, "app_control_observe", {
        tool: "observe",
        app: "com.example.editor",
      });

      expect(result.isError).toBe(true);
      expect(result.content).toContain("not available");
      expect(result.content).toContain("app-control");
      // No envelope dispatched.
      expect(sentMessages).toHaveLength(0);
    });

    test("returns isError when proxy exists but no client is connected", async () => {
      mockHasClient = false;
      const proxy = new HostAppControlProxy("conv-1");
      const ctx = buildMockContext(proxy);

      const result = await surfaceProxyResolver(ctx, "app_control_observe", {
        tool: "observe",
        app: "com.example.editor",
      });

      expect(result.isError).toBe(true);
      expect(result.content).toContain("not available");
      expect(sentMessages).toHaveLength(0);

      proxy.dispose();
    });

    test("returns isError for app_control_stop when no proxy is attached", async () => {
      const ctx = buildMockContext();

      const result = await surfaceProxyResolver(ctx, "app_control_stop", {
        tool: "stop",
      });

      expect(result.isError).toBe(true);
      expect(result.content).toContain("not available");
      expect(sentMessages).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Dispatch through proxy.request
  // -------------------------------------------------------------------------

  describe("non-stop tools dispatch through proxy.request", () => {
    test("app_control_observe routes through proxy and returns observation", async () => {
      const proxy = new HostAppControlProxy("conv-1");
      const ctx = buildMockContext(proxy, "conv-1");

      const resultPromise = surfaceProxyResolver(ctx, "app_control_observe", {
        tool: "observe",
        app: "com.example.editor",
      });

      // The proxy fired exactly one host_app_control_request envelope.
      expect(sentMessages).toHaveLength(1);
      const sent = sentMessages[0] as Record<string, unknown>;
      expect(sent.type).toBe("host_app_control_request");
      expect(sent.toolName).toBe("app_control_observe");
      expect(sent.conversationId).toBe("conv-1");
      expect(sent.input).toEqual({
        tool: "observe",
        app: "com.example.editor",
      });

      const requestId = sent.requestId as string;
      proxy.resolve(requestId, {
        requestId: "ignored-by-proxy",
        state: "running",
        executionResult: "Window observed",
      });

      const result = await resultPromise;
      expect(result.isError).toBe(false);
      expect(result.content).toContain("State: running");
      expect(result.content).toContain("Window observed");

      proxy.dispose();
    });
  });

  // -------------------------------------------------------------------------
  // Local short-circuit on app_control_stop
  // -------------------------------------------------------------------------

  describe("app_control_stop short-circuits locally", () => {
    test("calls proxy.dispose() and returns a stopped summary without a client round-trip", async () => {
      const proxy = new HostAppControlProxy("conv-1");
      const ctx = buildMockContext(proxy);

      let disposeCalls = 0;
      const realDispose = proxy.dispose.bind(proxy);
      proxy.dispose = () => {
        disposeCalls++;
        realDispose();
      };

      let requestCalls = 0;
      const realRequest = proxy.request.bind(proxy);
      proxy.request = (...args) => {
        requestCalls++;
        return realRequest(...args);
      };

      const result = await surfaceProxyResolver(ctx, "app_control_stop", {
        tool: "stop",
      });

      expect(result.isError).toBe(false);
      expect(result.content.toLowerCase()).toContain("stopped");
      expect(disposeCalls).toBe(1);
      expect(requestCalls).toBe(0);
      // No envelope dispatched for the local short-circuit.
      expect(sentMessages).toHaveLength(0);
    });

    test("clears the conversation reference via setHostAppControlProxy(undefined) when the setter is provided", async () => {
      const proxy = new HostAppControlProxy("conv-1");

      // Capture how the resolver clears the proxy reference. The setter
      // mirrors Conversation.setHostAppControlProxy: dispose the existing
      // proxy when transitioning to undefined.
      const setterCalls: Array<unknown> = [];
      let attached: InstanceType<typeof HostAppControlProxy> | undefined =
        proxy;
      const setter = (
        next: InstanceType<typeof HostAppControlProxy> | undefined,
      ) => {
        setterCalls.push(next);
        if (attached && attached !== next) attached.dispose();
        attached = next;
      };

      const ctx = buildMockContext(proxy, "conv-1", setter);

      const result = await surfaceProxyResolver(ctx, "app_control_stop", {
        tool: "stop",
      });

      expect(result.isError).toBe(false);
      // The resolver invoked the setter with undefined exactly once.
      expect(setterCalls).toEqual([undefined]);
      expect(attached).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Discriminator injection (Gap A)
  // -------------------------------------------------------------------------

  describe("tool discriminator injection", () => {
    test("injects `tool` derived from toolName when the agent input omits it", async () => {
      const proxy = new HostAppControlProxy("conv-1");
      const ctx = buildMockContext(proxy, "conv-1");

      // Agent inputs do not carry the discriminator — the resolver has to
      // synthesize it from `toolName` ("app_control_observe" → "observe")
      // before forwarding to the proxy / desktop client.
      const resultPromise = surfaceProxyResolver(ctx, "app_control_observe", {
        app: "com.example.editor",
      });

      expect(sentMessages).toHaveLength(1);
      const sent = sentMessages[0] as Record<string, unknown>;
      expect(sent.input).toEqual({
        tool: "observe",
        app: "com.example.editor",
      });

      const requestId = sent.requestId as string;
      proxy.resolve(requestId, {
        requestId: "ignored-by-proxy",
        state: "running",
      });
      await resultPromise;

      proxy.dispose();
    });

    test('injects `tool: "start"` so the singleton-lock guard fires', async () => {
      // Establish a lock owned by conv-other.
      const ownerProxy = new HostAppControlProxy("conv-other");
      const ownerCtrl = new AbortController();
      const ownerPromise = ownerProxy.request(
        "app_control_start",
        { tool: "start", app: "com.example.editor" },
        "conv-other",
        ownerCtrl.signal,
      );
      const ownerSent = sentMessages[0] as Record<string, unknown>;
      ownerProxy.resolve(ownerSent.requestId as string, {
        requestId: "ignored-by-proxy",
        state: "running",
      });
      await ownerPromise;
      sentMessages.length = 0;

      // conv-1 attempts to start without a discriminator in its input. The
      // resolver must inject `tool: "start"`, which causes the proxy's
      // singleton-lock guard to fire and reject without dispatching.
      const proxy = new HostAppControlProxy("conv-1");
      const ctx = buildMockContext(proxy, "conv-1");
      const result = await surfaceProxyResolver(ctx, "app_control_start", {
        app: "com.example.editor",
      });

      expect(result.isError).toBe(true);
      expect(result.content).toContain("conv-other");
      expect(sentMessages).toHaveLength(0); // No envelope dispatched.

      proxy.dispose();
      ownerProxy.dispose();
    });
  });
});
