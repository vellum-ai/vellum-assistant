import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { ServerMessage } from "../daemon/message-protocol.js";
import type { InteractiveUiResult } from "../runtime/interactive-ui.js";

let broadcastImpl: (msg: ServerMessage) => void = () => {};
mock.module("../runtime/assistant-event-hub.js", () => ({
  broadcastMessage: (msg: ServerMessage) => broadcastImpl(msg),
}));

import {
  canShowInteractiveUi,
  cleanupStandaloneSurface,
  handleSurfaceAction,
  showStandaloneSurface,
  type SurfaceConversationContext,
} from "../daemon/conversation-surfaces.js";

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Build a minimal SurfaceConversationContext stub for testing standalone
 * surface lifecycle. Only the fields accessed by the standalone surface
 * functions are populated.
 */
function createMockContext(
  overrides?: Partial<{
    hasNoClient: boolean;
    supportsDynamicUi: boolean;
    channel: string;
  }>,
): SurfaceConversationContext & {
  sentMessages: ServerMessage[];
  enqueuedMessages: Array<{ content: string; requestId: string }>;
} {
  const sentMessages: ServerMessage[] = [];
  broadcastImpl = (msg: ServerMessage) => sentMessages.push(msg);
  const enqueuedMessages: Array<{ content: string; requestId: string }> = [];

  return {
    conversationId: "test-conv-1",
    assistantId: undefined,
    trustContext: undefined,
    channelCapabilities: overrides?.channel
      ? {
          channel: overrides.channel,
          supportsDynamicUi: overrides.supportsDynamicUi ?? true,
        }
      : undefined,
    traceEmitter: {
      emit: () => {},
    },
    sendToClient: (msg: ServerMessage) => sentMessages.push(msg),
    pendingSurfaceActions: new Map(),
    lastSurfaceAction: new Map(),
    surfaceState: new Map(),
    surfaceUndoStacks: new Map(),
    accumulatedSurfaceState: new Map(),
    surfaceActionRequestIds: new Set(),
    pendingStandaloneSurfaces: new Map(),
    recentlyCompletedStandaloneSurfaces: new Map(),
    currentTurnSurfaces: [],
    hostCuProxy: undefined,
    hasNoClient: overrides?.hasNoClient ?? false,
    isProcessing: () => false,
    enqueueMessage: (content, _attachments, _onEvent, requestId) => {
      const resolvedId = requestId ?? "mock-request-id";
      enqueuedMessages.push({ content, requestId: resolvedId });
      return { queued: false, requestId: resolvedId };
    },
    getQueueDepth: () => 0,
    processMessage: async () => "msg-id",
    withSurface: async <T>(_surfaceId: string, fn: () => T | Promise<T>) =>
      fn(),
    sentMessages,
    enqueuedMessages,
  };
}

// ── canShowInteractiveUi ─────────────────────────────────────────────

describe("canShowInteractiveUi", () => {
  test("returns true when client is connected and no channel caps", () => {
    expect(
      canShowInteractiveUi({
        hasNoClient: false,
        channelCapabilities: undefined,
      }),
    ).toBe(true);
  });

  test("returns false when hasNoClient is true", () => {
    expect(
      canShowInteractiveUi({
        hasNoClient: true,
        channelCapabilities: undefined,
      }),
    ).toBe(false);
  });

  test("returns false when channel does not support dynamic UI", () => {
    expect(
      canShowInteractiveUi({
        hasNoClient: false,
        channelCapabilities: { channel: "sms", supportsDynamicUi: false },
      }),
    ).toBe(false);
  });

  test("returns true when channel supports dynamic UI", () => {
    expect(
      canShowInteractiveUi({
        hasNoClient: false,
        channelCapabilities: { channel: "web", supportsDynamicUi: true },
      }),
    ).toBe(true);
  });
});

// ── showStandaloneSurface ────────────────────────────────────────────

describe("showStandaloneSurface", () => {
  let timers: ReturnType<typeof setTimeout>[] = [];

  beforeEach(() => {
    timers = [];
  });

  afterEach(() => {
    // Safety cleanup of any lingering timers
    for (const t of timers) clearTimeout(t);
  });

  test("fails closed when no client is connected", async () => {
    const ctx = createMockContext({ hasNoClient: true });
    const result = await showStandaloneSurface(
      ctx,
      {
        conversationId: "test-conv-1",
        surfaceType: "confirmation",
        data: { message: "Are you sure?" },
      },
      "surf-1",
    );

    expect(result.status).toBe("cancelled");
    expect(result.surfaceId).toBe("surf-1");
    // No ui_surface_show should have been emitted
    expect(ctx.sentMessages).toHaveLength(0);
    // No pending entries
    expect(ctx.pendingStandaloneSurfaces!.size).toBe(0);
  });

  test("fails closed when channel does not support dynamic UI", async () => {
    const ctx = createMockContext({ channel: "sms", supportsDynamicUi: false });
    const result = await showStandaloneSurface(
      ctx,
      {
        conversationId: "test-conv-1",
        surfaceType: "confirmation",
        data: { message: "Are you sure?" },
      },
      "surf-2",
    );

    expect(result.status).toBe("cancelled");
    expect(ctx.pendingStandaloneSurfaces!.size).toBe(0);
  });

  test("emits ui_surface_show and registers pending entry", async () => {
    const ctx = createMockContext();

    // Start the surface request (it will block until action or timeout)
    const resultPromise = showStandaloneSurface(
      ctx,
      {
        conversationId: "test-conv-1",
        surfaceType: "confirmation",
        title: "Confirm action",
        data: { message: "Are you sure?" },
        actions: [
          { id: "confirm", label: "Yes", variant: "primary" },
          { id: "cancel", label: "No", variant: "secondary" },
        ],
        timeoutMs: 60_000,
      },
      "surf-3",
    );

    // Pending entry should be registered
    expect(ctx.pendingStandaloneSurfaces!.has("surf-3")).toBe(true);
    // Surface state should be stored
    expect(ctx.surfaceState.has("surf-3")).toBe(true);
    // ui_surface_show should have been emitted
    expect(ctx.sentMessages.length).toBeGreaterThanOrEqual(1);
    const showMsg = ctx.sentMessages.find(
      (m) =>
        (m as unknown as Record<string, unknown>).type === "ui_surface_show",
    ) as unknown as Record<string, unknown> | undefined;
    expect(showMsg).toBeDefined();
    expect(showMsg?.surfaceId).toBe("surf-3");
    expect(showMsg?.surfaceType).toBe("confirmation");
    expect(showMsg?.title).toBe("Confirm action");

    // Resolve by simulating user action via handleSurfaceAction
    await handleSurfaceAction(ctx, "surf-3", "confirm", {});

    const result = await resultPromise;
    expect(result.status).toBe("submitted");
    expect(result.surfaceId).toBe("surf-3");
    expect(result.actionId).toBe("confirm");
  });

  test("resolves with submitted status on confirm action", async () => {
    const ctx = createMockContext();
    const resultPromise = showStandaloneSurface(
      ctx,
      {
        conversationId: "test-conv-1",
        surfaceType: "confirmation",
        data: { message: "Proceed?" },
        timeoutMs: 60_000,
      },
      "surf-4",
    );

    await handleSurfaceAction(ctx, "surf-4", "confirm", { extra: "data" });
    const result = await resultPromise;

    expect(result.status).toBe("submitted");
    expect(result.actionId).toBe("confirm");
    expect(result.submittedData).toEqual({ extra: "data" });
  });

  test("resolves with cancelled status on cancel action", async () => {
    const ctx = createMockContext();
    const resultPromise = showStandaloneSurface(
      ctx,
      {
        conversationId: "test-conv-1",
        surfaceType: "confirmation",
        data: { message: "Proceed?" },
        timeoutMs: 60_000,
      },
      "surf-5",
    );

    await handleSurfaceAction(ctx, "surf-5", "cancel");
    const result = await resultPromise;

    expect(result.status).toBe("cancelled");
    expect(result.actionId).toBe("cancel");
  });

  test("resolves with timed_out status on timeout", async () => {
    const ctx = createMockContext();
    const resultPromise = showStandaloneSurface(
      ctx,
      {
        conversationId: "test-conv-1",
        surfaceType: "confirmation",
        data: { message: "Quick!" },
        timeoutMs: 50, // Very short timeout for test
      },
      "surf-6",
    );

    const result = await resultPromise;
    expect(result.status).toBe("timed_out");
    expect(result.surfaceId).toBe("surf-6");
  });

  test("timeout emits ui_surface_complete to dismiss the client surface", async () => {
    const ctx = createMockContext();
    const resultPromise = showStandaloneSurface(
      ctx,
      {
        conversationId: "test-conv-1",
        surfaceType: "confirmation",
        data: { message: "Quick!" },
        timeoutMs: 50, // Very short timeout for test
      },
      "surf-6b",
    );

    await resultPromise;

    // The timeout handler should emit ui_surface_complete so the client
    // dismisses the surface and prevents stale interactions.
    const completeMsg = ctx.sentMessages.find((m) => {
      const r = m as unknown as Record<string, unknown>;
      return r.type === "ui_surface_complete" && r.surfaceId === "surf-6b";
    }) as unknown as Record<string, unknown> | undefined;
    expect(completeMsg).toBeDefined();
    expect(completeMsg?.conversationId).toBe("test-conv-1");
    expect(completeMsg?.summary).toBe("Timed out");
  });

  test("timeout still resolves when emit throws", async () => {
    const ctx = createMockContext();
    let showEmitted = false;
    broadcastImpl = (msg: ServerMessage) => {
      const type = (msg as unknown as Record<string, unknown>).type;
      if (type === "ui_surface_show") {
        showEmitted = true;
        ctx.sentMessages.push(msg);
        return;
      }
      if (type === "ui_surface_complete") {
        throw new Error("emit failed");
      }
    };

    const resultPromise = showStandaloneSurface(
      ctx,
      {
        conversationId: "test-conv-1",
        surfaceType: "confirmation",
        data: { message: "Quick!" },
        timeoutMs: 50,
      },
      "surf-emit-err",
    );

    const result = await resultPromise;
    expect(showEmitted).toBe(true);
    // Despite the emit error, the promise should resolve with timed_out
    expect(result.status).toBe("timed_out");
    expect(result.surfaceId).toBe("surf-emit-err");
    // Cleanup should still have happened
    expect(ctx.pendingStandaloneSurfaces!.has("surf-emit-err")).toBe(false);
    expect(ctx.surfaceState.has("surf-emit-err")).toBe(false);
  });

  test("late action after timeout is silently dropped — not forwarded to LLM", async () => {
    const ctx = createMockContext();
    const resultPromise = showStandaloneSurface(
      ctx,
      {
        conversationId: "test-conv-1",
        surfaceType: "confirmation",
        data: { message: "Quick!" },
        timeoutMs: 50,
      },
      "surf-6c",
    );

    // Wait for timeout to fire
    const result = await resultPromise;
    expect(result.status).toBe("timed_out");

    // Verify the server-side state is fully cleaned up after timeout.
    expect(ctx.pendingStandaloneSurfaces!.has("surf-6c")).toBe(false);
    expect(ctx.surfaceState.has("surf-6c")).toBe(false);
    expect(ctx.pendingSurfaceActions.has("surf-6c")).toBe(false);

    // The surfaceId should now be in the tombstone set.
    expect(ctx.recentlyCompletedStandaloneSurfaces!.has("surf-6c")).toBe(true);

    // Now simulate a late user click after the surface has timed out.
    // Without the tombstone guard, this would fall through to the
    // history-restored path and enqueue a message to the LLM.
    await handleSurfaceAction(ctx, "surf-6c", "confirm", {});

    // No messages should have been enqueued to the LLM
    expect(ctx.enqueuedMessages).toHaveLength(0);
  });

  test("late action after user-resolved surface is silently dropped", async () => {
    const ctx = createMockContext();
    const resultPromise = showStandaloneSurface(
      ctx,
      {
        conversationId: "test-conv-1",
        surfaceType: "confirmation",
        data: { message: "Proceed?" },
        timeoutMs: 60_000,
      },
      "surf-6d",
    );

    // User confirms — resolves the surface
    await handleSurfaceAction(ctx, "surf-6d", "confirm");
    const result = await resultPromise;
    expect(result.status).toBe("submitted");

    // Tombstone should be recorded
    expect(ctx.recentlyCompletedStandaloneSurfaces!.has("surf-6d")).toBe(true);

    // A duplicate/late click arrives — must be silently dropped
    await handleSurfaceAction(ctx, "surf-6d", "confirm", {});

    // No messages should have been enqueued to the LLM
    expect(ctx.enqueuedMessages).toHaveLength(0);
  });

  test("consumed callback does NOT trigger LLM follow-up", async () => {
    const ctx = createMockContext();
    const resultPromise = showStandaloneSurface(
      ctx,
      {
        conversationId: "test-conv-1",
        surfaceType: "confirmation",
        data: { message: "Proceed?" },
        timeoutMs: 60_000,
      },
      "surf-7",
    );

    await handleSurfaceAction(ctx, "surf-7", "confirm");
    await resultPromise;

    // Verify no messages were enqueued to the LLM
    expect(ctx.enqueuedMessages).toHaveLength(0);
  });

  test("emits ui_surface_complete on user action", async () => {
    const ctx = createMockContext();
    const resultPromise = showStandaloneSurface(
      ctx,
      {
        conversationId: "test-conv-1",
        surfaceType: "confirmation",
        data: { message: "Proceed?" },
        timeoutMs: 60_000,
      },
      "surf-8",
    );

    await handleSurfaceAction(ctx, "surf-8", "confirm", { answer: "yes" });
    await resultPromise;

    const completeMsg = ctx.sentMessages.find(
      (m) =>
        (m as unknown as Record<string, unknown>).type ===
        "ui_surface_complete",
    ) as unknown as Record<string, unknown> | undefined;
    expect(completeMsg).toBeDefined();
    expect(completeMsg?.surfaceId).toBe("surf-8");
    expect(completeMsg?.conversationId).toBe("test-conv-1");
  });
});

// ── cleanupStandaloneSurface ─────────────────────────────────────────

describe("cleanupStandaloneSurface", () => {
  test("clears timer, pending entry, and all surface state", () => {
    const ctx = createMockContext();
    const timer = setTimeout(() => {}, 60_000);

    ctx.pendingStandaloneSurfaces!.set("surf-c1", {
      resolve: () => {},
      timer,
      surfaceType: "confirmation",
    });
    ctx.surfaceState.set("surf-c1", {
      surfaceType: "confirmation",
      data: { message: "test" } as never,
    });
    ctx.pendingSurfaceActions.set("surf-c1", { surfaceType: "confirmation" });
    ctx.lastSurfaceAction.set("surf-c1", { actionId: "confirm" });
    ctx.accumulatedSurfaceState.set("surf-c1", { key: "val" });
    ctx.surfaceUndoStacks.set("surf-c1", ["old"]);

    cleanupStandaloneSurface(ctx, "surf-c1");

    expect(ctx.pendingStandaloneSurfaces!.has("surf-c1")).toBe(false);
    expect(ctx.surfaceState.has("surf-c1")).toBe(false);
    expect(ctx.pendingSurfaceActions.has("surf-c1")).toBe(false);
    expect(ctx.lastSurfaceAction.has("surf-c1")).toBe(false);
    expect(ctx.accumulatedSurfaceState.has("surf-c1")).toBe(false);
    expect(ctx.surfaceUndoStacks.has("surf-c1")).toBe(false);

    // Tombstone should be recorded for the completed surface
    expect(ctx.recentlyCompletedStandaloneSurfaces!.has("surf-c1")).toBe(true);

    // Cleanup the timer and tombstone timer ourselves for the test
    clearTimeout(timer);
    const tombstoneTimer =
      ctx.recentlyCompletedStandaloneSurfaces!.get("surf-c1");
    if (tombstoneTimer) clearTimeout(tombstoneTimer);
  });

  test("is idempotent — safe to call multiple times", () => {
    const ctx = createMockContext();
    // Call on a surfaceId that was never registered
    cleanupStandaloneSurface(ctx, "nonexistent");
    // No error should be thrown, no state should change
    expect(ctx.pendingStandaloneSurfaces!.size).toBe(0);
    expect(ctx.surfaceState.size).toBe(0);
  });
});

// ── Cleanup on dispose path ──────────────────────────────────────────

describe("standalone surface cleanup on conversation dispose", () => {
  test("all pending standalone surfaces are cancelled on dispose", async () => {
    const ctx = createMockContext();
    const results: InteractiveUiResult[] = [];

    // Start two standalone surfaces
    const p1 = showStandaloneSurface(
      ctx,
      {
        conversationId: "test-conv-1",
        surfaceType: "confirmation",
        data: { message: "First?" },
        timeoutMs: 60_000,
      },
      "surf-d1",
    );
    const p2 = showStandaloneSurface(
      ctx,
      {
        conversationId: "test-conv-1",
        surfaceType: "form",
        data: { fields: [] },
        timeoutMs: 60_000,
      },
      "surf-d2",
    );

    expect(ctx.pendingStandaloneSurfaces!.size).toBe(2);

    // Simulate conversation dispose — cancel all pending with dismiss
    // notifications, matching the Conversation.dispose() implementation.
    for (const [surfaceId, entry] of ctx.pendingStandaloneSurfaces!) {
      clearTimeout(entry.timer);
      broadcastImpl({
        type: "ui_surface_dismiss",
        conversationId: ctx.conversationId,
        surfaceId,
      } as ServerMessage);
      entry.resolve({ status: "cancelled", surfaceId });
    }
    ctx.pendingStandaloneSurfaces!.clear();

    results.push(await p1, await p2);

    expect(results[0].status).toBe("cancelled");
    expect(results[0].surfaceId).toBe("surf-d1");
    expect(results[1].status).toBe("cancelled");
    expect(results[1].surfaceId).toBe("surf-d2");
    expect(ctx.pendingStandaloneSurfaces!.size).toBe(0);
  });

  test("dispose emits ui_surface_dismiss for each pending surface", async () => {
    const ctx = createMockContext();

    // Start two standalone surfaces
    const p1 = showStandaloneSurface(
      ctx,
      {
        conversationId: "test-conv-1",
        surfaceType: "confirmation",
        data: { message: "First?" },
        timeoutMs: 60_000,
      },
      "surf-d3",
    );
    const p2 = showStandaloneSurface(
      ctx,
      {
        conversationId: "test-conv-1",
        surfaceType: "form",
        data: { fields: [] },
        timeoutMs: 60_000,
      },
      "surf-d4",
    );

    // Clear sentMessages so we only see dispose-related messages
    ctx.sentMessages.length = 0;

    // Simulate the dispose path (matching Conversation.dispose())
    for (const [surfaceId, entry] of ctx.pendingStandaloneSurfaces!) {
      clearTimeout(entry.timer);
      broadcastImpl({
        type: "ui_surface_dismiss",
        conversationId: ctx.conversationId,
        surfaceId,
      } as ServerMessage);
      entry.resolve({ status: "cancelled", surfaceId });
    }
    ctx.pendingStandaloneSurfaces!.clear();

    await p1;
    await p2;

    // Verify a ui_surface_dismiss was emitted for each surface
    const dismissMessages = ctx.sentMessages.filter(
      (m) =>
        (m as unknown as Record<string, unknown>).type === "ui_surface_dismiss",
    ) as unknown as Array<Record<string, unknown>>;
    expect(dismissMessages).toHaveLength(2);
    const dismissedIds = dismissMessages.map((m) => m.surfaceId).sort();
    expect(dismissedIds).toEqual(["surf-d3", "surf-d4"]);
  });
});

// ── Form surface type ────────────────────────────────────────────────

describe("standalone form surface", () => {
  test("resolves with submitted data on submit action", async () => {
    const ctx = createMockContext();
    const resultPromise = showStandaloneSurface(
      ctx,
      {
        conversationId: "test-conv-1",
        surfaceType: "form",
        title: "Enter details",
        data: {
          fields: [{ id: "name", type: "text", label: "Name", required: true }],
        },
        timeoutMs: 60_000,
      },
      "surf-f1",
    );

    // Verify surface state was created correctly for form type
    const state = ctx.surfaceState.get("surf-f1");
    expect(state?.surfaceType).toBe("form");

    await handleSurfaceAction(ctx, "surf-f1", "submit", { name: "Alice" });
    const result = await resultPromise;

    expect(result.status).toBe("submitted");
    expect(result.submittedData).toEqual({ name: "Alice" });

    // Cleanup should be complete
    expect(ctx.pendingStandaloneSurfaces!.has("surf-f1")).toBe(false);
    expect(ctx.surfaceState.has("surf-f1")).toBe(false);
  });
});
