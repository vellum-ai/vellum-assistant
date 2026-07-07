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
// Default principal id used for both ctx.trustContext and clients in the
// existing single-user tests. Tests that exercise cross-user behaviour
// override this on individual clients and on the SurfaceConversationContext.
const DEFAULT_PRINCIPAL = "user-1";
type MockClient = {
  clientId: string;
  capabilities: string[];
  actorPrincipalId?: string;
};
let mockHubClients: MockClient[] = [];

mock.module("../runtime/assistant-event-hub.js", () => ({
  broadcastMessage: (msg: unknown) => sentMessages.push(msg),
  assistantEventHub: {
    getMostRecentClientByCapability: (cap: string) =>
      cap === "host_app_control" && mockHasClient
        ? { id: "mock-client" }
        : null,
    listClientsByCapability: (cap: string) =>
      mockHubClients.filter((c) => c.capabilities.includes(cap)),
    getClientById: (id: string) =>
      mockHubClients.find((c) => c.clientId === id),
    getActorPrincipalIdForClient: (id: string) =>
      mockHubClients.find((c) => c.clientId === id)?.actorPrincipalId,
  },
}));

mock.module("../runtime/pending-interactions.js", () => ({
  register: () => undefined,
  resolve: () => undefined,
  get: () => undefined,
  getByKind: () => [],
  getByConversation: () => [],
  removeByConversation: () => {},
}));

const { surfaceProxyResolver } =
  await import("../daemon/conversation-surfaces.js");
const {
  HostAppControlProxy,
  _resetActiveAppControlSession,
  _setActiveAppControlSession,
} = await import("../daemon/host-app-control-proxy.js");
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
  trustGuardianPrincipalId: string | null = DEFAULT_PRINCIPAL,
  actorPrincipalId: string | null = trustGuardianPrincipalId,
): SurfaceConversationContext {
  return {
    conversationId,
    trustContext:
      trustGuardianPrincipalId != null
        ? {
            sourceChannel: "vellum",
            trustClass: "guardian",
            guardianPrincipalId: trustGuardianPrincipalId,
          }
        : undefined,
    authContext:
      actorPrincipalId != null
        ? ({ actorPrincipalId } as SurfaceConversationContext["authContext"])
        : undefined,
    currentTurnAuthContext:
      actorPrincipalId != null
        ? ({
            actorPrincipalId,
          } as SurfaceConversationContext["currentTurnAuthContext"])
        : undefined,
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
    mockHubClients = [];
    _resetActiveAppControlSession();
  });

  afterEach(() => {
    _resetActiveAppControlSession();
    mockHubClients = [];
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

    test("app_control_stop succeeds idempotently when no proxy is attached", async () => {
      // Stop is local-only and runs BEFORE the isAvailable() gate so a
      // disconnected client cannot strand the singleton lock. With no proxy
      // attached at all, it must still succeed as a no-op without dispatching.
      const ctx = buildMockContext();

      const result = await surfaceProxyResolver(ctx, "app_control_stop", {
        tool: "stop",
      });

      expect(result.isError).toBe(false);
      expect(result.content.toLowerCase()).toContain("stopped");
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
      _setActiveAppControlSession({
        conversationId: "conv-1",
        app: "com.example.editor",
      });

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

    test("app_control_observe rejects owner client when current requester is a trusted contact", async () => {
      mockHubClients = [
        {
          clientId: "owner-client",
          capabilities: ["host_app_control"],
          actorPrincipalId: "owner-user",
        },
      ];
      const proxy = new HostAppControlProxy("conv-1");
      const ctx = buildMockContext(
        proxy,
        "conv-1",
        undefined,
        "owner-user",
        "trusted-contact-user",
      );
      _setActiveAppControlSession({
        conversationId: "conv-1",
        app: "com.example.editor",
      });

      const result = await surfaceProxyResolver(ctx, "app_control_observe", {
        tool: "observe",
        app: "com.example.editor",
      });

      expect(result.isError).toBe(true);
      expect(result.content).toContain("current actor");
      expect(sentMessages).toHaveLength(0);

      proxy.dispose();
    });

    test("app_control_observe rejects when only another actor has a capable client", async () => {
      mockHubClients = [
        {
          clientId: "client-other",
          capabilities: ["host_app_control"],
          actorPrincipalId: "user-other",
        },
      ];
      const proxy = new HostAppControlProxy("conv-1");
      const ctx = buildMockContext(proxy, "conv-1");
      _setActiveAppControlSession({
        conversationId: "conv-1",
        app: "com.example.editor",
      });

      const result = await surfaceProxyResolver(ctx, "app_control_observe", {
        tool: "observe",
        app: "com.example.editor",
      });

      expect(result.isError).toBe(true);
      expect(result.content).toContain("current actor");
      // No envelope dispatched.
      expect(sentMessages).toHaveLength(0);

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
      _setActiveAppControlSession({
        conversationId: "conv-1",
        app: "com.example.editor",
      });

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

  // -------------------------------------------------------------------------
  // target_client_id validation — mirrors host_cu's targetClientId tests in
  // cu-unified-flow.test.ts. The resolver validates the explicit target
  // before recordAction-equivalents so an invalid or cross-user id never
  // reaches the proxy.
  // -------------------------------------------------------------------------

  describe("target_client_id validation", () => {
    test("returns fast error when target_client_id does not match any connected client", async () => {
      mockHubClients = [
        {
          clientId: "client-a",
          capabilities: ["host_app_control"],
          actorPrincipalId: DEFAULT_PRINCIPAL,
        },
      ];
      const proxy = new HostAppControlProxy("conv-1");
      const ctx = buildMockContext(proxy, "conv-1");
      _setActiveAppControlSession({
        conversationId: "conv-1",
        app: "com.example.editor",
      });

      const result = await surfaceProxyResolver(ctx, "app_control_observe", {
        app: "com.example.editor",
        target_client_id: "missing-client",
      });

      expect(result.isError).toBe(true);
      expect(result.content).toContain("missing-client");
      expect(result.content).toContain("host_app_control");
      // No envelope dispatched — fail-fast before request().
      expect(sentMessages).toHaveLength(0);

      proxy.dispose();
    });

    test("returns fast error when target_client_id points to a client without host_app_control capability", async () => {
      mockHubClients = [
        {
          clientId: "wrong-cap-client",
          capabilities: ["host_bash"], // not host_app_control
          actorPrincipalId: DEFAULT_PRINCIPAL,
        },
      ];
      const proxy = new HostAppControlProxy("conv-1");
      const ctx = buildMockContext(proxy, "conv-1");
      _setActiveAppControlSession({
        conversationId: "conv-1",
        app: "com.example.editor",
      });

      const result = await surfaceProxyResolver(ctx, "app_control_observe", {
        app: "com.example.editor",
        target_client_id: "wrong-cap-client",
      });

      expect(result.isError).toBe(true);
      expect(result.content).toContain("wrong-cap-client");
      expect(result.content).toContain("does not support host_app_control");
      expect(sentMessages).toHaveLength(0);

      proxy.dispose();
    });

    test("dispatches with targetClientId when target_client_id is valid", async () => {
      mockHubClients = [
        {
          clientId: "client-a",
          capabilities: ["host_app_control"],
          actorPrincipalId: DEFAULT_PRINCIPAL,
        },
        {
          clientId: "client-b",
          capabilities: ["host_app_control"],
          actorPrincipalId: DEFAULT_PRINCIPAL,
        },
      ];
      const proxy = new HostAppControlProxy("conv-1");
      const ctx = buildMockContext(proxy, "conv-1");
      _setActiveAppControlSession({
        conversationId: "conv-1",
        app: "com.example.editor",
        targetClientId: "client-b",
      });

      const resultPromise = surfaceProxyResolver(ctx, "app_control_observe", {
        app: "com.example.editor",
        target_client_id: "client-b",
      });

      // Exactly one envelope dispatched, addressed to client-b.
      expect(sentMessages).toHaveLength(1);
      const sent = sentMessages[0] as Record<string, unknown>;
      expect(sent.type).toBe("host_app_control_request");
      expect(sent.targetClientId).toBe("client-b");

      proxy.resolve(sent.requestId as string, {
        requestId: "ignored-by-proxy",
        state: "running",
      });
      const result = await resultPromise;
      expect(result.isError).toBe(false);

      proxy.dispose();
    });
  });

  // -------------------------------------------------------------------------
  // Multi-client ambiguity guard — when the LLM omits target_client_id and
  // multiple same-user host_app_control clients are connected, the resolver
  // must error rather than broadcast (one app-control session per client).
  // -------------------------------------------------------------------------

  describe("multi-client ambiguity guard", () => {
    test("errors when multiple same-user clients connected and no target_client_id given", async () => {
      mockHubClients = [
        {
          clientId: "client-a",
          capabilities: ["host_app_control"],
          actorPrincipalId: DEFAULT_PRINCIPAL,
        },
        {
          clientId: "client-b",
          capabilities: ["host_app_control"],
          actorPrincipalId: DEFAULT_PRINCIPAL,
        },
      ];
      const proxy = new HostAppControlProxy("conv-1");
      const ctx = buildMockContext(proxy, "conv-1");
      _setActiveAppControlSession({
        conversationId: "conv-1",
        app: "com.example.editor",
      });

      const result = await surfaceProxyResolver(ctx, "app_control_observe", {
        app: "com.example.editor",
      });

      expect(result.isError).toBe(true);
      expect(result.content).toContain("Multiple host_app_control clients");
      expect(result.content).toContain("target_client_id");
      // No envelope dispatched.
      expect(sentMessages).toHaveLength(0);

      proxy.dispose();
    });

    test("auto-resolves to the unique same-user client when cross-user clients are also present", async () => {
      mockHubClients = [
        {
          clientId: "client-mine",
          capabilities: ["host_app_control"],
          actorPrincipalId: DEFAULT_PRINCIPAL,
        },
        {
          clientId: "client-other",
          capabilities: ["host_app_control"],
          actorPrincipalId: "user-2",
        },
      ];
      const proxy = new HostAppControlProxy("conv-1");
      const ctx = buildMockContext(proxy, "conv-1");
      _setActiveAppControlSession({
        conversationId: "conv-1",
        app: "com.example.editor",
        targetClientId: "client-mine",
      });

      const resultPromise = surfaceProxyResolver(ctx, "app_control_observe", {
        app: "com.example.editor",
      });

      // Resolver must explicitly target the same-user client to prevent the
      // proxy from broadcasting the action across the cross-user client too.
      expect(sentMessages).toHaveLength(1);
      const sent = sentMessages[0] as Record<string, unknown>;
      expect(sent.targetClientId).toBe("client-mine");

      proxy.resolve(sent.requestId as string, {
        requestId: "ignored-by-proxy",
        state: "running",
      });
      const result = await resultPromise;
      expect(result.isError).toBe(false);

      proxy.dispose();
    });

    test("single same-user client with no target resolves to that client", async () => {
      mockHubClients = [
        {
          clientId: "only-client",
          capabilities: ["host_app_control"],
          actorPrincipalId: DEFAULT_PRINCIPAL,
        },
      ];
      const proxy = new HostAppControlProxy("conv-1");
      const ctx = buildMockContext(proxy, "conv-1");
      _setActiveAppControlSession({
        conversationId: "conv-1",
        app: "com.example.editor",
        targetClientId: "only-client",
      });

      const resultPromise = surfaceProxyResolver(ctx, "app_control_observe", {
        app: "com.example.editor",
      });

      expect(sentMessages).toHaveLength(1);
      const sent = sentMessages[0] as Record<string, unknown>;
      // Single same-user client → auto-resolved by pickSameUserAutoResolve.
      // targetClientId may be set to the resolved client id.
      expect(sent.type).toBe("host_app_control_request");

      proxy.resolve(sent.requestId as string, {
        requestId: "ignored-by-proxy",
        state: "running",
      });
      const result = await resultPromise;
      expect(result.isError).toBe(false);

      proxy.dispose();
    });
  });

  // -------------------------------------------------------------------------
  // Same-user enforcement — even when target_client_id is provided, a
  // cross-user client can never be addressed.
  // -------------------------------------------------------------------------

  describe("same-user enforcement", () => {
    test("rejects targeted dispatch from a different actor principal", async () => {
      mockHubClients = [
        {
          clientId: "other-user-client",
          capabilities: ["host_app_control"],
          actorPrincipalId: "user-2",
        },
      ];
      const proxy = new HostAppControlProxy("conv-1");
      const ctx = buildMockContext(proxy, "conv-1");
      _setActiveAppControlSession({
        conversationId: "conv-1",
        app: "com.example.editor",
      });

      const result = await surfaceProxyResolver(ctx, "app_control_observe", {
        app: "com.example.editor",
        target_client_id: "other-user-client",
      });

      expect(result.isError).toBe(true);
      // No envelope dispatched.
      expect(sentMessages).toHaveLength(0);

      proxy.dispose();
    });

    test("rejects when the conversation has no source actor principal", async () => {
      mockHubClients = [
        {
          clientId: "client-a",
          capabilities: ["host_app_control"],
          actorPrincipalId: DEFAULT_PRINCIPAL,
        },
      ];
      const proxy = new HostAppControlProxy("conv-1");
      const ctx = buildMockContext(
        proxy,
        "conv-1",
        undefined,
        /* trustGuardianPrincipalId */ null,
      );
      _setActiveAppControlSession({
        conversationId: "conv-1",
        app: "com.example.editor",
      });

      const result = await surfaceProxyResolver(ctx, "app_control_observe", {
        app: "com.example.editor",
        target_client_id: "client-a",
      });

      expect(result.isError).toBe(true);
      expect(sentMessages).toHaveLength(0);

      proxy.dispose();
    });
  });
});
