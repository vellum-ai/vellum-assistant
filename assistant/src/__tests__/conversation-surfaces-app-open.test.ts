import { describe, expect, test } from "bun:test";

import {
  createSurfaceMutex,
  type SurfaceConversationContext,
  surfaceProxyResolver,
} from "../daemon/conversation-surfaces.js";
import type {
  ServerMessage,
  SurfaceData,
  SurfaceType,
} from "../daemon/message-protocol.js";

interface ContextOptions {
  hasNoClient?: boolean;
  channelCapabilities?: { channel: string; supportsDynamicUi: boolean };
}

function makeContext(
  sent: ServerMessage[] = [],
  options: ContextOptions = {},
): SurfaceConversationContext {
  return {
    conversationId: "session-1",
    hasNoClient: options.hasNoClient,
    channelCapabilities: options.channelCapabilities,
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
    enqueueMessage: () => ({ queued: false, requestId: "req-1" }),
    getQueueDepth: () => 0,
    processMessage: async () => "ok",
    withSurface: createSurfaceMutex(),
  };
}

describe("app_open render-capability gate", () => {
  test("returns an error without broadcasting on a clientless turn", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent, { hasNoClient: true });

    const result = await surfaceProxyResolver(ctx, "app_open", {
      app_id: "app-1",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("connected client");
    expect(sent).toHaveLength(0);
  });

  test("returns an error on a channel without dynamic UI (e.g. Slack)", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent, {
      channelCapabilities: { channel: "slack", supportsDynamicUi: false },
    });

    const result = await surfaceProxyResolver(ctx, "app_open", {
      app_id: "app-1",
    });

    expect(result.isError).toBe(true);
    expect(sent).toHaveLength(0);
  });
});
