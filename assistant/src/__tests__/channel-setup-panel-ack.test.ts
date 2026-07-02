/**
 * `ui_show channel_setup` acknowledgment flow.
 *
 * `open_panel` is a side-effect-only command that is never persisted to the
 * transcript, so a dropped event is unrecoverable. The tool result must
 * therefore be gated on a client acknowledgment: "displayed" means a client
 * actually rendered the drawer; every other outcome (nack, timeout, no
 * client, aborted turn) is a tool error the model can act on instead of
 * announcing a panel the user cannot see.
 */
import { describe, expect, test } from "bun:test";

import type { OpenPanelEvent } from "../api/events/open-panel.js";
import {
  createSurfaceMutex,
  handleSurfaceAction,
  openChannelSetupPanel,
  type SurfaceConversationContext,
  surfaceProxyResolver,
} from "../daemon/conversation-surfaces.js";
import type {
  ServerMessage,
  SurfaceData,
  SurfaceType,
} from "../daemon/message-protocol.js";

function makeContext(
  sent: ServerMessage[] = [],
  overrides: Partial<SurfaceConversationContext> = {},
): SurfaceConversationContext {
  return {
    conversationId: "session-1",
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
    pendingStandaloneSurfaces: new Map(),
    recentlyCompletedStandaloneSurfaces: new Map(),
    currentTurnSurfaces: [],
    isProcessing: () => false,
    enqueueMessage: () => ({ queued: false, requestId: "req-1" }),
    getQueueDepth: () => 0,
    processMessage: async () => "ok",
    withSurface: createSurfaceMutex(),
    ...overrides,
  };
}

function findOpenPanel(sent: ServerMessage[]): OpenPanelEvent | undefined {
  return sent.find((msg): msg is OpenPanelEvent => msg.type === "open_panel");
}

async function waitForOpenPanel(
  sent: ServerMessage[],
): Promise<OpenPanelEvent> {
  for (let i = 0; i < 20 && !findOpenPanel(sent); i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const event = findOpenPanel(sent);
  expect(event).toBeDefined();
  return event!;
}

describe("ui_show channel_setup acknowledgment", () => {
  test("emits open_panel with a surfaceId and succeeds once the client acks", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent);

    const resultPromise = surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "channel_setup",
      data: { channel: "slack" },
    });

    const event = await waitForOpenPanel(sent);
    expect(event.panelType).toBe("channel_setup");
    expect(event.conversationId).toBe("session-1");
    expect(event.data).toEqual({ channel: "slack" });
    expect(typeof event.surfaceId).toBe("string");

    const surfaceId = event.surfaceId!;
    expect(ctx.pendingStandaloneSurfaces!.has(surfaceId)).toBe(true);
    // Registered so the surface-action route can resolve the conversation
    // by surfaceId when the ack arrives.
    expect(ctx.surfaceState.get(surfaceId)?.surfaceType).toBe("channel_setup");

    await handleSurfaceAction(ctx, surfaceId, "ack");

    const result = await resultPromise;
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content as string)).toEqual({
      surfaceId,
      status: "displayed",
    });

    // Ack consumed the pending entry without leaking surface state.
    expect(ctx.pendingStandaloneSurfaces!.size).toBe(0);
    expect(ctx.surfaceState.has(surfaceId)).toBe(false);
  });

  test("returns a tool error when the client nacks", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent);

    const resultPromise = surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "channel_setup",
      data: { channel: "slack" },
    });

    const event = await waitForOpenPanel(sent);
    await handleSurfaceAction(ctx, event.surfaceId!, "nack", {
      reason: "no_active_assistant",
    });

    const result = await resultPromise;
    expect(result.isError).toBe(true);
    expect(result.content).toContain("no_active_assistant");
    expect(result.content).toContain("Do NOT tell the user the panel is open");
  });

  test("fails closed without emitting when no interactive client is connected", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent, { hasNoClient: true });

    const result = await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "channel_setup",
      data: { channel: "slack" },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("no connected client");
    expect(findOpenPanel(sent)).toBeUndefined();
  });

  test("times out into a tool error when no client acknowledges", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent);

    const ack = await openChannelSetupPanel(
      ctx,
      "surface-timeout",
      { channel: "slack" },
      { timeoutMs: 10 },
    );

    expect(ack.status).toBe("timed_out");
    // Timed-out entries are fully cleaned up and tombstoned so a late ack
    // cannot fall through to the LLM-turn path.
    expect(ctx.pendingStandaloneSurfaces!.size).toBe(0);
    expect(ctx.surfaceState.has("surface-timeout")).toBe(false);
    expect(
      ctx.recentlyCompletedStandaloneSurfaces!.has("surface-timeout"),
    ).toBe(true);
  });

  test("resolves cancelled when the turn is aborted mid-wait", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent);
    const controller = new AbortController();

    const ackPromise = openChannelSetupPanel(
      ctx,
      "surface-abort",
      { channel: "slack" },
      { signal: controller.signal, timeoutMs: 5_000 },
    );
    controller.abort();

    const ack = await ackPromise;
    expect(ack.status).toBe("cancelled");
    expect(ack.cancellationReason).toBe("resolver_unavailable");
    expect(ctx.pendingStandaloneSurfaces!.size).toBe(0);
    expect(ctx.surfaceState.has("surface-abort")).toBe(false);
  });
});
