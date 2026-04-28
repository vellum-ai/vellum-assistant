/**
 * Unit tests for the `_action: "launch_conversation"` dispatch branch in
 * `handleSurfaceAction` AND the `launchConversation` helper it calls into.
 *
 * The real `launchConversation` is exercised end-to-end: its DB-hitting
 * dependencies (`conversation-key-store`, `conversation-crud`) and its
 * registered daemon deps are stubbed so the helper runs without a DB.
 * This lets the tests assert the full invariant set in one place:
 *
 *   - `handleSurfaceAction` does NOT publish `open_conversation` itself —
 *     `launchConversation` is the sole emitter of that event.
 *   - Exactly one `open_conversation` is published per launch, carrying
 *     the caller-supplied `focus` value (false for fan-out launchers).
 *   - The handler returns promptly — the seed turn
 *     (`persistAndProcessMessage`) is fire-and-forget.
 *   - `originTrustContext` is forwarded to the spawned conversation.
 *
 * These tests guard the single-emitter invariant: exactly one
 * `open_conversation` event is published per launch, with the
 * caller-supplied `focus` value preserved so fan-out launchers do not
 * steal focus from the origin.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Module-level mocks ─────────────────────────────────────────────

// Hub publish capture — used by the single-emit assertions. We spread
// the real module into each override so unrelated exports (e.g.
// `formatSseFrame` on assistant-event) stay accessible to other
// importers loaded indirectly through `conversation-surfaces.ts`.
const publishCalls: Array<unknown> = [];
const realHub = await import("../../runtime/assistant-event-hub.js");
const realEvent = await import("../../runtime/assistant-event.js");
mock.module("../../runtime/assistant-event-hub.js", () => ({
  ...realHub,
  assistantEventHub: {
    publish: async (event: unknown) => {
      publishCalls.push(event);
    },
  },
}));
mock.module("../../runtime/assistant-event.js", () => ({
  ...realEvent,
  // Pass-through so `focus` / `conversationId` can be asserted directly
  // on the captured event's `message` payload.
  buildAssistantEvent: (
    message: unknown,
    conversationId?: string,
  ) => ({ message, conversationId }),
}));

// Stub DB helpers so the real `launchConversation` can run without a DB.
// We spread the real module and override only the specific functions the
// helper uses — other importers (e.g. conversation-surfaces itself)
// continue to see `getMessages`, `updateMessageContent`, etc.
let nextKeyStoreResult: { conversationId: string } = {
  conversationId: "conv-new",
};
const updateTitleCalls: Array<{ conversationId: string; title: string }> = [];
const realKeyStore = await import("../../memory/conversation-key-store.js");
const realCrud = await import("../../memory/conversation-crud.js");
mock.module("../../memory/conversation-key-store.js", () => ({
  ...realKeyStore,
  getOrCreateConversation: (_key: string) => nextKeyStoreResult,
}));
mock.module("../../memory/conversation-crud.js", () => ({
  ...realCrud,
  updateConversationTitle: (
    conversationId: string,
    title: string,
    _priority: number,
  ) => {
    updateTitleCalls.push({ conversationId, title });
  },
}));

// Dynamic imports after mock.module calls so the stubs take effect
// before the modules under test are loaded.
const { createSurfaceMutex, handleSurfaceAction } =
  await import("../conversation-surfaces.js");
const { registerLaunchConversationDeps, resetLaunchConversationDeps } =
  await import("../conversation-launch.js");
type SurfaceConversationContext =
  import("../conversation-surfaces.js").SurfaceConversationContext;
type TrustContext = import("../trust-context.js").TrustContext;
type ServerMessage = import("../message-protocol.js").ServerMessage;
type SurfaceData = import("../message-protocol.js").SurfaceData;
type SurfaceType = import("../message-protocol.js").SurfaceType;

// ── launchConversation deps harness ────────────────────────────────

interface DepsHarness {
  getOrCreateCalls: Array<string>;
  processCalls: Array<{ conversationId: string; content: string }>;
  lastTrustContext(): unknown | null;
  resolveProcess: () => void;
  rejectProcess: (err: Error) => void;
  /** Resolves once `persistAndProcessMessage` has actually been invoked. */
  processStarted: Promise<void>;
}

function setupLaunchDeps(): DepsHarness {
  const getOrCreateCalls: Array<string> = [];
  const processCalls: Array<{ conversationId: string; content: string }> = [];
  let trustContextOnConversation: unknown | null = null;
  let resolveProcess = () => {};
  let rejectProcess: (err: Error) => void = () => {};
  let markProcessStarted = () => {};
  const processStarted = new Promise<void>((resolve) => {
    markProcessStarted = resolve;
  });

  const fakeConversation = {
    setTrustContext: (c: unknown) => {
      trustContextOnConversation = c;
    },
  };

  registerLaunchConversationDeps({
    getOrCreateConversation: async (id: string) => {
      getOrCreateCalls.push(id);
      return fakeConversation as never;
    },
    persistAndProcessMessage: (conversationId: string, content: string) => {
      processCalls.push({ conversationId, content });
      markProcessStarted();
      return new Promise((resolve, reject) => {
        resolveProcess = () => resolve({ messageId: "msg-1" });
        rejectProcess = (err) => reject(err);
      });
    },
    publishAssistantEvent: () => {},
  });

  return {
    getOrCreateCalls,
    processCalls,
    lastTrustContext: () => trustContextOnConversation,
    resolveProcess: () => resolveProcess(),
    rejectProcess: (err: Error) => rejectProcess(err),
    processStarted,
  };
}

// ── Surface-context harness ────────────────────────────────────────

interface HarnessContext extends SurfaceConversationContext {
  sent: ServerMessage[];
  enqueueCalls: Array<{ content: string }>;
  processCalls: Array<{ content: string }>;
}

function makeContext(
  overrides?: Partial<SurfaceConversationContext>,
): HarnessContext {
  const sent: ServerMessage[] = [];
  const enqueueCalls: Array<{ content: string }> = [];
  const processCalls: Array<{ content: string }> = [];

  const base: SurfaceConversationContext = {
    conversationId: "origin-conv-id",
    traceEmitter: { emit: () => {} },
    sendToClient: (msg) => sent.push(msg),
    pendingSurfaceActions: new Map<string, { surfaceType: SurfaceType }>(),
    lastSurfaceAction: new Map<
      string,
      { actionId: string; data?: Record<string, unknown> }
    >(),
    surfaceState: new Map<
      string,
      { surfaceType: SurfaceType; data: SurfaceData; title?: string }
    >(),
    surfaceUndoStacks: new Map<string, string[]>(),
    accumulatedSurfaceState: new Map<string, Record<string, unknown>>(),
    surfaceActionRequestIds: new Set<string>(),
    currentTurnSurfaces: [],
    isProcessing: () => false,
    enqueueMessage: (content: string) => {
      enqueueCalls.push({ content });
      return { queued: false, requestId: "enq-req" };
    },
    getQueueDepth: () => 0,
    processMessage: async (content: string) => {
      processCalls.push({ content });
      return "ok";
    },
    withSurface: createSurfaceMutex(),
    ...overrides,
  };

  return Object.assign(base, {
    sent,
    enqueueCalls,
    processCalls,
  }) as HarnessContext;
}

/**
 * Register a surface on `ctx`. Launcher cards arrive as history-restored
 * surfaces (no `pendingSurfaceActions` entry) — matching how the card
 * actually reaches `handleSurfaceAction` after reconstruction.
 */
function registerCardSurface(
  ctx: SurfaceConversationContext,
  surfaceId: string,
): void {
  ctx.surfaceState.set(surfaceId, {
    surfaceType: "card",
    data: { title: "Launch" } as unknown as SurfaceData,
  });
}

// Helper: filter captured publish calls down to `open_conversation`
// events. Typed so assertions can reach the inner `message` payload.
function openConversationEvents(): Array<{
  conversationId?: string;
  message: {
    type: "open_conversation";
    conversationId: string;
    title?: string;
    anchorMessageId?: string;
    focus?: boolean;
  };
}> {
  return publishCalls
    .filter((e): e is { message: { type: "open_conversation" } } => {
      const ev = e as { message?: { type?: string } };
      return ev.message?.type === "open_conversation";
    })
    .map(
      (e) =>
        e as unknown as {
          conversationId?: string;
          message: {
            type: "open_conversation";
            conversationId: string;
            title?: string;
            anchorMessageId?: string;
            focus?: boolean;
          };
        },
    );
}

// ── Tests ──────────────────────────────────────────────────────────

describe("handleSurfaceAction — launch_conversation dispatch", () => {
  beforeEach(() => {
    publishCalls.length = 0;
    updateTitleCalls.length = 0;
    nextKeyStoreResult = { conversationId: "conv-new" };
    // Reset module-level `_deps` so a test that forgets to call
    // `setupLaunchDeps()` cannot accidentally piggy-back on deps left
    // registered by a previous test. Each test that exercises the launch
    // helper must call `setupLaunchDeps()` explicitly.
    resetLaunchConversationDeps();
  });

  test("launches new conversation with inherited trust context and no chat message", async () => {
    nextKeyStoreResult = { conversationId: "conv-launched-1" };
    const harness = setupLaunchDeps();
    const originTrustContext: TrustContext = {
      sourceChannel: "vellum",
      trustClass: "guardian",
      guardianChatId: "chat-guardian",
      guardianPrincipalId: "principal-guardian",
    };
    const ctx = makeContext({ trustContext: originTrustContext });
    registerCardSurface(ctx, "surface-1");

    const result = await handleSurfaceAction(ctx, "surface-1", "launch", {
      _action: "launch_conversation",
      title: "New Thread",
      seedPrompt: "S",
    });

    // 1. Response shape.
    expect(result).toEqual({
      accepted: true,
      conversationId: "conv-launched-1",
    });

    // 2. Exactly ONE `open_conversation` event was published for the new
    //    id, with focus: false. `launchConversation` is the sole emitter;
    //    `handleSurfaceAction` delegates entirely to it.
    const openEvents = openConversationEvents();
    expect(openEvents).toHaveLength(1);
    expect(openEvents[0].message.conversationId).toBe("conv-launched-1");
    expect(openEvents[0].message.focus).toBe(false);
    expect(openEvents[0].message.title).toBe("New Thread");

    // 3. The spawned conversation inherited the origin's trust context.
    expect(harness.lastTrustContext()).toEqual(originTrustContext);

    // 4. Seed turn was kicked off fire-and-forget — resolve it to clean
    //    up the pending promise the harness stubbed.
    await harness.processStarted;
    expect(harness.processCalls).toHaveLength(1);
    expect(harness.processCalls[0].content).toBe("S");
    harness.resolveProcess();

    // 5. No chat message side effect on the origin conversation — neither
    //    the LLM pipeline nor the `[User action on app: ...]` text echo.
    expect(ctx.enqueueCalls).toHaveLength(0);
    expect(ctx.processCalls).toHaveLength(0);
    const anyUserActionEcho = ctx.sent.some(
      (msg) =>
        "text" in msg &&
        typeof msg.text === "string" &&
        msg.text.includes("[User action on app:"),
    );
    expect(anyUserActionEcho).toBe(false);
  });

  test("returns error when title or seedPrompt is missing", async () => {
    const ctx = makeContext();
    registerCardSurface(ctx, "surface-2");

    // Missing seedPrompt.
    const missingSeed = await handleSurfaceAction(ctx, "surface-2", "launch", {
      _action: "launch_conversation",
      title: "T",
    });
    expect(missingSeed).toEqual({
      accepted: false,
      error: "missing_title_or_seedPrompt",
    });

    // Missing title.
    const missingTitle = await handleSurfaceAction(ctx, "surface-2", "launch", {
      _action: "launch_conversation",
      seedPrompt: "S",
    });
    expect(missingTitle).toEqual({
      accepted: false,
      error: "missing_title_or_seedPrompt",
    });

    // Neither field: still the same validation error.
    const missingBoth = await handleSurfaceAction(ctx, "surface-2", "launch", {
      _action: "launch_conversation",
    });
    expect(missingBoth).toEqual({
      accepted: false,
      error: "missing_title_or_seedPrompt",
    });

    // No launch-side effects in any of the failed validations — no events,
    // no queued origin-conversation messages.
    expect(publishCalls).toHaveLength(0);
    expect(ctx.enqueueCalls).toHaveLength(0);
  });

  test("omits originTrustContext when origin conversation has none", async () => {
    nextKeyStoreResult = { conversationId: "conv-launched-3" };
    const harness = setupLaunchDeps();
    // No `trustContext` on the origin context — simulating the
    // no-inherited-guardian path.
    const ctx = makeContext();
    registerCardSurface(ctx, "surface-3");

    const result = await handleSurfaceAction(ctx, "surface-3", "launch", {
      _action: "launch_conversation",
      title: "T",
      seedPrompt: "S",
    });

    expect(result).toEqual({
      accepted: true,
      conversationId: "conv-launched-3",
    });

    // Trust context was never applied to the spawned conversation.
    expect(harness.lastTrustContext()).toBeNull();

    // Still exactly one open_conversation event with focus: false.
    const openEvents = openConversationEvents();
    expect(openEvents).toHaveLength(1);
    expect(openEvents[0].message.focus).toBe(false);

    await harness.processStarted;
    harness.resolveProcess();
  });

  test("handler returns before the seed turn resolves (fire-and-forget)", async () => {
    nextKeyStoreResult = { conversationId: "conv-nonblocking" };
    const harness = setupLaunchDeps();
    const ctx = makeContext();
    registerCardSurface(ctx, "surface-4");

    // The harness's `persistAndProcessMessage` returns a pending Promise
    // that only resolves when we call `resolveProcess()`. If the helper
    // (or handler) awaited it, `await handleSurfaceAction(...)` below
    // would hang. The fact that it resolves while the seed turn is still
    // pending proves the fire-and-forget behavior that the HTTP route
    // relies on for the fan-out multi-launch UX.
    const result = await handleSurfaceAction(ctx, "surface-4", "launch", {
      _action: "launch_conversation",
      title: "T",
      seedPrompt: "S",
    });

    expect(result).toEqual({
      accepted: true,
      conversationId: "conv-nonblocking",
    });

    // Seed turn is in-flight but not yet resolved. Prove the helper
    // actually invoked it (so we know fire-and-forget is wired), then
    // resolve it to clean up.
    await harness.processStarted;
    expect(harness.processCalls).toHaveLength(1);
    harness.resolveProcess();
  });

  test("seed turn rejection is swallowed by the helper's .catch()", async () => {
    nextKeyStoreResult = { conversationId: "conv-seed-fails" };
    const harness = setupLaunchDeps();
    const ctx = makeContext();
    registerCardSurface(ctx, "surface-5");

    const result = await handleSurfaceAction(ctx, "surface-5", "launch", {
      _action: "launch_conversation",
      title: "T",
      seedPrompt: "boom",
    });

    expect(result).toEqual({
      accepted: true,
      conversationId: "conv-seed-fails",
    });

    // Reject the pending seed turn — the helper's `.catch()` handler
    // must swallow it. If it didn't, Bun would surface the unhandled
    // rejection at test-end and this test would fail.
    await harness.processStarted;
    harness.rejectProcess(new Error("seed-turn-failed"));
    // Give the microtask queue a tick so the `.catch()` runs before
    // the test completes.
    await Promise.resolve();
    await Promise.resolve();
  });

  test("dispatches launch even when pendingSurfaceActions has an entry for the surface (first-click case)", async () => {
    // Regression for the gap that left the launch branch unreachable on the
    // FIRST click of a freshly-rendered persistent launcher card. `ui_show`
    // unconditionally sets `pendingSurfaceActions` for any interactive card
    // (regardless of `persistent`), so without this fix `handleSurfaceAction`
    // saw `pending` truthy, skipped the launch dispatch, and fell through to
    // the pending path — emitting the `[User action on card surface: ...]`
    // message and triggering a full LLM round-trip on every click. The plan
    // claimed to eliminate that round-trip; this test enforces it.
    nextKeyStoreResult = { conversationId: "conv-pending-set" };
    const harness = setupLaunchDeps();
    const ctx = makeContext();
    registerCardSurface(ctx, "surface-pending");
    // Simulate `ui_show` having stamped a pending entry for this surface
    // (which it does for any interactive card, including persistent ones).
    ctx.pendingSurfaceActions.set("surface-pending", { surfaceType: "card" });

    const result = await handleSurfaceAction(ctx, "surface-pending", "launch", {
      _action: "launch_conversation",
      title: "T",
      seedPrompt: "S",
    });

    expect(result).toEqual({
      accepted: true,
      conversationId: "conv-pending-set",
    });

    // Exactly one open_conversation event with focus: false — the launch
    // branch ran, not the pending fallthrough.
    const openEvents = openConversationEvents();
    expect(openEvents).toHaveLength(1);
    expect(openEvents[0].message.conversationId).toBe("conv-pending-set");
    expect(openEvents[0].message.focus).toBe(false);

    // Critical: NO message was enqueued onto the origin conversation. If the
    // launch dispatch had fallen through to the pending path, the
    // `[User action on card surface: ...]` text would have been enqueued and
    // an LLM turn would have started.
    expect(ctx.enqueueCalls).toHaveLength(0);

    // Pending entry was deleted so subsequent sibling clicks on the same
    // persistent card aren't blocked behind a stale "owes-an-answer" flag.
    expect(ctx.pendingSurfaceActions.has("surface-pending")).toBe(false);

    await harness.processStarted;
    harness.resolveProcess();
  });
});
