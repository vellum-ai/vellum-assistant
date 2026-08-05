import { describe, expect, test } from "bun:test";

import type { AssistantEvent, AssistantEventEnvelope } from "../api/index.js";
import type { Conversation } from "../daemon/conversation.js";
import {
  createSurfaceMutex,
  handleSurfaceAction,
} from "../daemon/conversation-surfaces.js";
import type { SurfaceType } from "../daemon/message-protocol.js";
import { assistantEventHub } from "../runtime/assistant-event-hub.js";
import { asConversation } from "./helpers/mock-conversation.js";

const CONV_ID = "surfaces-queued-emit-conv";

/**
 * Minimal Conversation whose `enqueueMessage` behaves like the
 * real one on the queued path: it acks the accepted enqueue by emitting
 * `message_queued` on the caller-supplied `onEvent` sink, then reports
 * `queued: true`.
 */
function makeQueuedContext(): Conversation {
  return asConversation({
    conversationId: CONV_ID,
    sendToClient: () => {},
    pendingSurfaceActions: new Map<string, { surfaceType: SurfaceType }>(),
    lastSurfaceAction: new Map<
      string,
      { actionId: string; data?: Record<string, unknown> }
    >(),
    surfaceState: new Map(),
    surfaceUndoStacks: new Map(),
    accumulatedSurfaceState: new Map(),
    surfaceActionRequestIds: new Set<string>(),
    currentTurnSurfaces: [],
    isProcessing: () => true,
    enqueueMessage: (options) => {
      const requestId = options.requestId ?? "req-queued";
      options.onEvent?.({
        type: "message_queued",
        conversationId: CONV_ID,
        requestId,
        position: 1,
      });
      return { queued: true, requestId };
    },
    getQueueDepth: () => 1,
    processMessage: async () => "ok",
    withSurface: createSurfaceMutex(),
  });
}

describe("surface action queued path", () => {
  test("a queued surface action broadcasts exactly one message_queued", async () => {
    const ctx = makeQueuedContext();
    ctx.surfaceState.set("card-1", {
      surfaceType: "card",
      data: { title: "Test card" },
      title: "Test card",
      actions: [{ id: "confirm", label: "Confirm", style: "primary" }],
    });
    ctx.pendingSurfaceActions.set("card-1", { surfaceType: "card" });

    const received: AssistantEvent[] = [];
    const subscription = assistantEventHub.subscribe({
      type: "process",
      callback: (envelope: AssistantEventEnvelope) => {
        if (envelope.conversationId === CONV_ID) {
          received.push(envelope.message);
        }
      },
    });
    try {
      await handleSurfaceAction(ctx, "card-1", "confirm", {});
      // Hub delivery is asynchronous; give the publish chain a beat.
      await new Promise((r) => setTimeout(r, 20));

      const queuedEvents = received.filter((e) => e.type === "message_queued");
      expect(queuedEvents).toHaveLength(1);
      expect(queuedEvents[0]).toMatchObject({
        conversationId: CONV_ID,
        position: 1,
      });
    } finally {
      subscription.dispose();
    }
  });
});
