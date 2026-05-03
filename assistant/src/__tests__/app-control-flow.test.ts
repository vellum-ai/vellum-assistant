/**
 * End-to-end app-control flow test.
 *
 * Drives a fake conversation through `app_control_start` →
 * `app_control_observe` → `app_control_stop` using the real
 * {@link HostAppControlProxy} (so the loop guard, singleton lock, and
 * result-formatting paths are exercised) plus the real route handler from
 * `host-app-control-routes.ts`. The mock layer captures broadcast
 * envelopes and bridges them back through the route handler the way the
 * desktop client does in production.
 *
 * Mirrors `cu-unified-flow.test.ts` for the CU pathway. App-control
 * differs in two notable ways:
 *  1. Result payloads carry `pngBase64` (not screenshots-as-strings) and
 *     surface as image content blocks with `media_type: "image/png"`.
 *  2. A module-level singleton lock guards `app_control_start` — only one
 *     conversation may hold an active session at a time.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Module mocks (must be installed before importing the units under test)
// ---------------------------------------------------------------------------
//
// Both the proxy (host-proxy-base) and the route handler reach into the
// `pendingInteractions` and `assistantEventHub` modules. We mock both so
// the test can:
//   - capture every broadcast envelope (assertion + driving the route),
//   - register pending interactions on broadcast (the way production
//     code does for other host-* requests in `assistant-event-hub.ts`),
//   - resolve those entries from the route handler.
//
// `conversation-store` is intentionally NOT mocked: replacing it would
// break sibling exports (deleteConversation, etc.) that the
// `conversation-surfaces.ts` import chain pulls in transitively. We use
// the real `setConversation` to register fake conversation entries.

const sentMessages: unknown[] = [];
let mockHasClient = true;

interface PendingEntry {
  conversationId: string;
  kind: string;
}
const pending = new Map<string, PendingEntry>();

mock.module("../runtime/assistant-event-hub.js", () => ({
  broadcastMessage: (msg: unknown) => {
    sentMessages.push(msg);
    const m = msg as Record<string, unknown>;
    if (
      m.type === "host_app_control_request" &&
      typeof m.requestId === "string" &&
      typeof m.conversationId === "string"
    ) {
      pending.set(m.requestId, {
        conversationId: m.conversationId,
        kind: "host_app_control",
      });
    }
  },
  assistantEventHub: {
    getMostRecentClientByCapability: (cap: string) =>
      cap === "host_app_control" && mockHasClient
        ? { id: "mock-client" }
        : null,
  },
}));

mock.module("../runtime/pending-interactions.js", () => ({
  register: (requestId: string, entry: PendingEntry) =>
    pending.set(requestId, entry),
  get: (requestId: string) => pending.get(requestId),
  resolve: (requestId: string) => {
    const entry = pending.get(requestId);
    if (entry) pending.delete(requestId);
    return entry;
  },
  getByKind: () => [],
  getByConversation: () => [],
  removeByConversation: () => {},
}));

// ---------------------------------------------------------------------------
// Real imports (after mocks)
// ---------------------------------------------------------------------------

const {
  HostAppControlProxy,
  _getActiveAppControlConversationId,
  _resetActiveAppControlConversationId,
} = await import("../daemon/host-app-control-proxy.js");
const { ROUTES } = await import("../runtime/routes/host-app-control-routes.js");
const { surfaceProxyResolver } =
  await import("../daemon/conversation-surfaces.js");
const { setConversation, clearConversations } =
  await import("../daemon/conversation-store.js");
type SurfaceConversationContext =
  import("../daemon/conversation-surfaces.js").SurfaceConversationContext;

const handleHostAppControlResult = ROUTES.find(
  (r) => r.endpoint === "host-app-control-result",
)!.handler;

// Tiny base64 PNG-ish placeholder. Content is irrelevant to the result
// path — the proxy hashes the string for its loop guard but never decodes
// it, and the resulting content block carries the bytes through verbatim.
const TINY_PNG_B64 = "iVBORw0KGgoAAAA";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Build a SurfaceConversationContext with a real proxy attached. Only the
 * fields the app-control branch reads are populated — see
 * `cu-unified-flow.test.ts` for the analogous shape.
 */
function buildContext(
  proxy: InstanceType<typeof HostAppControlProxy>,
  conversationId = "test-conv",
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
    hostAppControlProxy: proxy,
    isProcessing: () => false,
    enqueueMessage: () => ({ queued: false, requestId: "r1" }),
    getQueueDepth: () => 0,
    processMessage: async () => "",
    withSurface: async (_id, fn) => fn(),
  };
}

/**
 * Register the proxy in the real conversation store keyed by
 * `conversationId` so the route handler's `findConversation()` lookup
 * routes POSTed results back to it. The fake conversation only needs the
 * `hostAppControlProxy` field — the route handler never reads anything
 * else off it.
 */
function registerConversation(
  conversationId: string,
  proxy: InstanceType<typeof HostAppControlProxy>,
): void {
  setConversation(conversationId, {
    hostAppControlProxy: proxy,
  } as never);
}

/**
 * Drive the full server → client → server roundtrip: post a result payload
 * through the real route handler for the most recently broadcast request.
 */
async function postResult(body: Record<string, unknown>): Promise<void> {
  const sent = sentMessages[sentMessages.length - 1] as Record<string, unknown>;
  const rid = sent.requestId as string;
  await handleHostAppControlResult({ body: { ...body, requestId: rid } });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("app-control end-to-end flow", () => {
  beforeEach(() => {
    sentMessages.length = 0;
    pending.clear();
    clearConversations();
    mockHasClient = true;
    _resetActiveAppControlConversationId();
  });

  afterEach(() => {
    _resetActiveAppControlConversationId();
    clearConversations();
  });

  // -------------------------------------------------------------------------
  // Test 1: app_control_start
  // -------------------------------------------------------------------------

  test("app_control_start: SSE broadcast → POST result → ToolExecutionResult, lock acquired", async () => {
    const conversationId = "conv-start";
    const proxy = new HostAppControlProxy(conversationId);
    const ctx = buildContext(proxy, conversationId);
    registerConversation(conversationId, proxy);

    const resultPromise = surfaceProxyResolver(ctx, "app_control_start", {
      tool: "start",
      app: "com.example.app",
    });

    // SSE broadcast captured with the expected envelope shape.
    expect(sentMessages).toHaveLength(1);
    const sent = sentMessages[0] as Record<string, unknown>;
    expect(sent.type).toBe("host_app_control_request");
    expect(sent.toolName).toBe("app_control_start");
    expect(sent.conversationId).toBe(conversationId);
    expect(sent.input).toEqual({ tool: "start", app: "com.example.app" });
    expect(typeof sent.requestId).toBe("string");

    // The pending interaction is registered (so the route handler can find it).
    const requestId = sent.requestId as string;
    expect(pending.has(requestId)).toBe(true);

    // Post a result through the real route handler. The proxy resolves on
    // the next tick.
    await postResult({
      state: "running",
      pngBase64: TINY_PNG_B64,
      executionResult: "App launched",
      windowBounds: { x: 0, y: 0, width: 1280, height: 800 },
    });

    const result = await resultPromise;

    expect(result.isError).toBe(false);
    expect(result.content).toContain("State: running");
    expect(result.content).toContain("App launched");
    expect(result.content).toContain("1280x800 at (0, 0)");
    expect(result.contentBlocks).toBeDefined();
    expect(result.contentBlocks).toHaveLength(1);
    expect(result.contentBlocks![0]).toEqual({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: TINY_PNG_B64,
      },
    });

    // Singleton lock is held by this conversation now.
    expect(_getActiveAppControlConversationId()).toBe(conversationId);

    proxy.dispose();
  });

  // -------------------------------------------------------------------------
  // Test 2: app_control_observe
  // -------------------------------------------------------------------------

  test("app_control_observe: result payload includes image content block", async () => {
    const conversationId = "conv-observe";
    const proxy = new HostAppControlProxy(conversationId);
    const ctx = buildContext(proxy, conversationId);
    registerConversation(conversationId, proxy);

    const resultPromise = surfaceProxyResolver(ctx, "app_control_observe", {
      tool: "observe",
      app: "com.example.app",
    });

    expect(sentMessages).toHaveLength(1);
    const sent = sentMessages[0] as Record<string, unknown>;
    expect(sent.toolName).toBe("app_control_observe");

    await postResult({
      state: "running",
      pngBase64: TINY_PNG_B64,
      executionResult: "Window observed",
    });

    const result = await resultPromise;

    expect(result.isError).toBe(false);
    expect(result.content).toContain("State: running");
    expect(result.content).toContain("Window observed");
    expect(result.contentBlocks).toBeDefined();
    expect(result.contentBlocks).toHaveLength(1);
    expect(result.contentBlocks![0]).toEqual({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: TINY_PNG_B64,
      },
    });

    proxy.dispose();
  });

  // -------------------------------------------------------------------------
  // Test 3: app_control_stop short-circuits locally
  // -------------------------------------------------------------------------

  test("app_control_stop: no SSE broadcast, dispose called, lock released", async () => {
    const conversationId = "conv-stop";
    const proxy = new HostAppControlProxy(conversationId);
    const ctx = buildContext(proxy, conversationId);
    registerConversation(conversationId, proxy);

    // Acquire the lock first via a real start round-trip — otherwise stop
    // is a no-op against an unset lock.
    const startPromise = surfaceProxyResolver(ctx, "app_control_start", {
      tool: "start",
      app: "com.example.app",
    });
    await postResult({ state: "running", pngBase64: TINY_PNG_B64 });
    await startPromise;
    expect(_getActiveAppControlConversationId()).toBe(conversationId);

    // Wrap dispose to verify it was called by the resolver.
    let disposeCalls = 0;
    const realDispose = proxy.dispose.bind(proxy);
    proxy.dispose = () => {
      disposeCalls++;
      realDispose();
    };

    sentMessages.length = 0;

    const result = await surfaceProxyResolver(ctx, "app_control_stop", {
      tool: "stop",
    });

    expect(result.isError).toBe(false);
    expect(result.content.toLowerCase()).toContain("stopped");
    // No broadcast on the local short-circuit.
    expect(sentMessages).toHaveLength(0);
    expect(disposeCalls).toBe(1);
    // Lock released.
    expect(_getActiveAppControlConversationId()).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Test 4: singleton lock blocks a second conversation
  // -------------------------------------------------------------------------

  test("singleton lock: second conversation's start is rejected naming the holder", async () => {
    const proxyA = new HostAppControlProxy("conv-a");
    const ctxA = buildContext(proxyA, "conv-a");
    registerConversation("conv-a", proxyA);

    const startA = surfaceProxyResolver(ctxA, "app_control_start", {
      tool: "start",
      app: "com.example.app",
    });
    await postResult({ state: "running", pngBase64: TINY_PNG_B64 });
    const resultA = await startA;
    expect(resultA.isError).toBe(false);
    expect(_getActiveAppControlConversationId()).toBe("conv-a");

    // Second conversation tries to start while conv-a holds the lock.
    sentMessages.length = 0;
    const proxyB = new HostAppControlProxy("conv-b");
    const ctxB = buildContext(proxyB, "conv-b");
    registerConversation("conv-b", proxyB);

    const resultB = await surfaceProxyResolver(ctxB, "app_control_start", {
      tool: "start",
      app: "com.example.app",
    });

    expect(resultB.isError).toBe(true);
    expect(resultB.content).toContain("conv-a");
    expect(resultB.content.toLowerCase()).toContain(
      "currently holds the app-control session",
    );
    // No envelope was dispatched for the rejected start.
    expect(sentMessages).toHaveLength(0);

    proxyA.dispose();
    proxyB.dispose();
  });
});
