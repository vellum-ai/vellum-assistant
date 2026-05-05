import { describe, expect, test } from "bun:test";

import {
  createSurfaceMutex,
  handleSurfaceAction,
  type SurfaceConversationContext,
  surfaceProxyResolver,
} from "../daemon/conversation-surfaces.js";
import type {
  ServerMessage,
  SurfaceData,
  SurfaceType,
} from "../daemon/message-protocol.js";

/**
 * Build a minimal SurfaceConversationContext for testing.
 * Tracks calls to enqueueMessage and processMessage so tests can assert
 * whether an LLM turn was triggered.
 */
function makeContext(opts?: {
  sent?: ServerMessage[];
}): SurfaceConversationContext & {
  enqueueCalls: Array<{ content: string; requestId: string }>;
  processCalls: Array<{ content: string; requestId?: string }>;
} {
  const sent = opts?.sent ?? [];
  const enqueueCalls: Array<{ content: string; requestId: string }> = [];
  const processCalls: Array<{ content: string; requestId?: string }> = [];

  return {
    conversationId: "test-session",
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
    enqueueMessage: (content, _attachments, _onEvent, requestId) => {
      const resolvedId = requestId ?? "mock-request-id";
      enqueueCalls.push({ content, requestId: resolvedId });
      return { queued: false, requestId: resolvedId };
    },
    getQueueDepth: () => 0,
    processMessage: async (content, _attachments, _onEvent, requestId) => {
      processCalls.push({ content, requestId });
      return "ok";
    },
    withSurface: createSurfaceMutex(),
    enqueueCalls,
    processCalls,
  };
}

/** Register a dynamic_page surface in the context so state_update is accepted. */
function registerDynamicPage(
  ctx: SurfaceConversationContext,
  surfaceId: string,
): void {
  ctx.pendingSurfaceActions.set(surfaceId, { surfaceType: "dynamic_page" });
  ctx.surfaceState.set(surfaceId, {
    surfaceType: "dynamic_page",
    data: { html: "<div>test</div>" } as SurfaceData,
  });
}

describe("state_update silent accumulation", () => {
  test("accumulates state from multiple calls via shallow merge", () => {
    const ctx = makeContext();
    registerDynamicPage(ctx, "surface-1");

    handleSurfaceAction(ctx, "surface-1", "state_update", { page: 2 });
    handleSurfaceAction(ctx, "surface-1", "state_update", {
      selectedTab: "overview",
    });
    handleSurfaceAction(ctx, "surface-1", "state_update", { page: 5 });

    const accumulated = ctx.accumulatedSurfaceState.get("surface-1");
    expect(accumulated).toEqual({ page: 5, selectedTab: "overview" });
  });

  test("ignores calls with undefined data", () => {
    const ctx = makeContext();
    registerDynamicPage(ctx, "surface-1");

    handleSurfaceAction(ctx, "surface-1", "state_update", { count: 1 });
    handleSurfaceAction(ctx, "surface-1", "state_update", undefined);

    const accumulated = ctx.accumulatedSurfaceState.get("surface-1");
    expect(accumulated).toEqual({ count: 1 });
  });

  test("does not accumulate for non-dynamic_page surfaces", () => {
    const ctx = makeContext();
    // Register as a table surface instead of dynamic_page
    ctx.pendingSurfaceActions.set("surface-table", { surfaceType: "table" });
    ctx.surfaceState.set("surface-table", {
      surfaceType: "table",
      data: {
        columns: [],
        rows: [],
      } as unknown as SurfaceData,
    });

    handleSurfaceAction(ctx, "surface-table", "state_update", { page: 1 });

    const accumulated = ctx.accumulatedSurfaceState.get("surface-table");
    expect(accumulated).toBeUndefined();
  });
});

describe("state_update does not trigger LLM", () => {
  test("does not call enqueueMessage or processMessage", () => {
    const ctx = makeContext();
    registerDynamicPage(ctx, "surface-1");

    handleSurfaceAction(ctx, "surface-1", "state_update", {
      currentSlide: 3,
    });

    expect(ctx.enqueueCalls).toHaveLength(0);
    expect(ctx.processCalls).toHaveLength(0);
  });

  test("does not add to surfaceActionRequestIds", () => {
    const ctx = makeContext();
    registerDynamicPage(ctx, "surface-1");

    handleSurfaceAction(ctx, "surface-1", "state_update", { zoom: 1.5 });

    expect(ctx.surfaceActionRequestIds.size).toBe(0);
  });
});

describe("accumulated state injection into reactive actions", () => {
  test("subsequent reactive action includes accumulated state in message content", () => {
    const ctx = makeContext();
    registerDynamicPage(ctx, "surface-1");

    // Accumulate some state
    handleSurfaceAction(ctx, "surface-1", "state_update", { page: 3 });
    handleSurfaceAction(ctx, "surface-1", "state_update", {
      selectedItem: "item-42",
    });

    // Fire a reactive action (e.g. "save")
    handleSurfaceAction(ctx, "surface-1", "save");

    // The enqueueMessage call should include the accumulated state
    expect(ctx.enqueueCalls).toHaveLength(1);
    const content = ctx.enqueueCalls[0].content;
    expect(content).toContain("Accumulated surface state:");
    expect(content).toContain('"page":3');
    expect(content).toContain('"selectedItem":"item-42"');
  });

  test("empty accumulated state is not appended", () => {
    const ctx = makeContext();
    registerDynamicPage(ctx, "surface-1");

    // Fire a reactive action without any prior state_update
    handleSurfaceAction(ctx, "surface-1", "refresh");

    expect(ctx.enqueueCalls).toHaveLength(1);
    const content = ctx.enqueueCalls[0].content;
    expect(content).not.toContain("Accumulated surface state:");
  });
});

describe("per-surface state isolation", () => {
  test("accumulated state from surface A does not appear in surface B reactive action", () => {
    const ctx = makeContext();
    registerDynamicPage(ctx, "surface-a");
    registerDynamicPage(ctx, "surface-b");

    // Accumulate state only on surface A
    handleSurfaceAction(ctx, "surface-a", "state_update", {
      filterA: "active",
    });

    // Fire a reactive action on surface B
    handleSurfaceAction(ctx, "surface-b", "submit");

    expect(ctx.enqueueCalls).toHaveLength(1);
    const content = ctx.enqueueCalls[0].content;
    expect(content).not.toContain("filterA");
    expect(content).not.toContain("Accumulated surface state:");
  });

  test("each surface maintains its own accumulated state", () => {
    const ctx = makeContext();
    registerDynamicPage(ctx, "surface-a");
    registerDynamicPage(ctx, "surface-b");

    handleSurfaceAction(ctx, "surface-a", "state_update", { page: 1 });
    handleSurfaceAction(ctx, "surface-b", "state_update", { page: 99 });

    expect(ctx.accumulatedSurfaceState.get("surface-a")).toEqual({ page: 1 });
    expect(ctx.accumulatedSurfaceState.get("surface-b")).toEqual({ page: 99 });
  });
});

describe("cleanup on dismiss", () => {
  test("ui_dismiss clears accumulated state for the surface", async () => {
    const ctx = makeContext();
    registerDynamicPage(ctx, "surface-1");

    // Accumulate state
    handleSurfaceAction(ctx, "surface-1", "state_update", { dirty: true });
    expect(ctx.accumulatedSurfaceState.get("surface-1")).toEqual({
      dirty: true,
    });

    // Dismiss via surfaceProxyResolver (ui_dismiss)
    await surfaceProxyResolver(ctx, "ui_dismiss", {
      surface_id: "surface-1",
    });

    // Accumulated state should be cleared
    expect(ctx.accumulatedSurfaceState.has("surface-1")).toBe(false);
  });

  test("ui_dismiss does not affect other surfaces accumulated state", async () => {
    const ctx = makeContext();
    registerDynamicPage(ctx, "surface-1");
    registerDynamicPage(ctx, "surface-2");

    handleSurfaceAction(ctx, "surface-1", "state_update", { x: 1 });
    handleSurfaceAction(ctx, "surface-2", "state_update", { y: 2 });

    await surfaceProxyResolver(ctx, "ui_dismiss", {
      surface_id: "surface-1",
    });

    expect(ctx.accumulatedSurfaceState.has("surface-1")).toBe(false);
    expect(ctx.accumulatedSurfaceState.get("surface-2")).toEqual({ y: 2 });
  });
});
