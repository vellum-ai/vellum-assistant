/**
 * Unit tests for the `_action: "launch_conversation"` dispatch branch in
 * `handleSurfaceAction`.
 *
 * `launchConversation` is mocked at the module level so we can assert what
 * parameters the dispatch branch passes in (including `originTrustContext`
 * inherited from the origin conversation) without standing up a real DB.
 * The mocking style mirrors
 * `assistant/src/__tests__/signal-launch-conversation.test.ts` — dynamic
 * imports after `mock.module` calls so the modules under test see the
 * stubs.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Module-level mocks ─────────────────────────────────────────────
//
// `launchConversation` is the only DB-hitting call path inside the new
// dispatch branch. Stub it so the test exercises dispatch logic in
// isolation: it records every call and returns a predictable id.

const launchCalls: Array<{
  title: string;
  seedPrompt: string;
  anchorMessageId?: string;
  originTrustContext?: unknown;
}> = [];
let nextLaunchResult: { conversationId: string } = {
  conversationId: "conv-new",
};

mock.module("../conversation-launch.js", () => ({
  launchConversation: async (params: {
    title: string;
    seedPrompt: string;
    anchorMessageId?: string;
    originTrustContext?: unknown;
  }) => {
    launchCalls.push({
      title: params.title,
      seedPrompt: params.seedPrompt,
      ...(params.anchorMessageId !== undefined
        ? { anchorMessageId: params.anchorMessageId }
        : {}),
      ...(params.originTrustContext !== undefined
        ? { originTrustContext: params.originTrustContext }
        : {}),
    });
    return nextLaunchResult;
  },
  // Preserve the shape of the real module so unrelated imports still resolve.
  registerLaunchConversationDeps: () => {},
}));

// Capture hub publish calls so the test can assert that
// `open_conversation` with `focus: false` is emitted for the new id.
const publishCalls: Array<unknown> = [];
mock.module("../../runtime/assistant-event-hub.js", () => ({
  assistantEventHub: {
    publish: async (event: unknown) => {
      publishCalls.push(event);
    },
  },
}));
mock.module("../../runtime/assistant-event.js", () => ({
  // Pass-through so `focus` / `conversationId` can be asserted directly on
  // the captured event's `message` payload.
  buildAssistantEvent: (
    assistantId: string,
    message: unknown,
    conversationId?: string,
  ) => ({ assistantId, message, conversationId }),
}));

// Dynamic imports after mock.module calls so the stubs take effect
// before the modules under test are loaded.
const { createSurfaceMutex, handleSurfaceAction } = await import(
  "../conversation-surfaces.js"
);
type SurfaceConversationContext =
  import("../conversation-surfaces.js").SurfaceConversationContext;
type TrustContext = import("../conversation-runtime-assembly.js").TrustContext;
type ServerMessage = import("../message-protocol.js").ServerMessage;
type SurfaceData = import("../message-protocol.js").SurfaceData;
type SurfaceType = import("../message-protocol.js").SurfaceType;

// ── Test harness ───────────────────────────────────────────────────

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

describe("handleSurfaceAction — launch_conversation dispatch", () => {
  beforeEach(() => {
    publishCalls.length = 0;
    launchCalls.length = 0;
    nextLaunchResult = { conversationId: "conv-new" };
  });

  test("launches new conversation with inherited trust context and no chat message", async () => {
    nextLaunchResult = { conversationId: "conv-launched-1" };
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

    // 2. `launchConversation` was invoked exactly once with the origin's
    //    trust context so the spawned conversation inherits the
    //    guardian scope.
    expect(launchCalls).toHaveLength(1);
    expect(launchCalls[0].title).toBe("New Thread");
    expect(launchCalls[0].seedPrompt).toBe("S");
    expect(launchCalls[0].originTrustContext).toEqual(originTrustContext);

    // 3. `open_conversation` with focus: false was published for the new id.
    const openEvents = publishCalls.filter((e) => {
      const ev = e as { message?: { type?: string } };
      return ev.message?.type === "open_conversation";
    });
    const focusFalseEvent = openEvents.find((e) => {
      const ev = e as {
        message: { focus?: boolean; conversationId?: string };
      };
      return (
        ev.message.focus === false &&
        ev.message.conversationId === "conv-launched-1"
      );
    });
    expect(focusFalseEvent).toBeDefined();

    // 4. No chat message side effect on the origin conversation — neither
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

    // No launch-side effects in any of the failed validations.
    expect(launchCalls).toHaveLength(0);
    expect(publishCalls).toHaveLength(0);
    expect(ctx.enqueueCalls).toHaveLength(0);
  });

  test("omits originTrustContext when origin conversation has none", async () => {
    nextLaunchResult = { conversationId: "conv-launched-3" };
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

    // With no origin trust context, the dispatch branch must NOT pass
    // one to `launchConversation`.
    expect(launchCalls).toHaveLength(1);
    expect("originTrustContext" in launchCalls[0]).toBe(false);
  });
});
