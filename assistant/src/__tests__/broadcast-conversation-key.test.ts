/**
 * Verifies that `broadcastMessage` sets `conversationKey` on conversation-scoped
 * events and leaves it `undefined` on global events (e.g.
 * `conversation_list_invalidated`).
 */
import { describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../signals/event-stream.js", () => ({
  appendEventToStream: () => {},
}));

import type { AssistantEvent } from "../runtime/assistant-event.js";
import {
  assistantEventHub,
  broadcastMessage,
} from "../runtime/assistant-event-hub.js";

// ── Helpers ──────────────────────────────────────────────────────────

/** Collect events published to the hub during a callback. */
async function collectEvents(
  fn: () => void,
): Promise<AssistantEvent[]> {
  const events: AssistantEvent[] = [];
  const sub = assistantEventHub.subscribe({
    type: "process",
    callback: (event) => {
      events.push(event);
    },
  });
  fn();
  // broadcastMessage chains publishes on a promise; wait for the microtask queue.
  await new Promise((r) => setTimeout(r, 50));
  sub.dispose();
  return events;
}

// ── Tests ────────────────────────────────────────────────────────────

describe("broadcastMessage — conversationKey", () => {
  test("sets conversationKey on conversation-scoped events", async () => {
    const conversationId = "conv-abc-123";
    const events = await collectEvents(() => {
      broadcastMessage(
        { type: "assistant_text_delta", text: "hello" },
        conversationId,
      );
    });

    expect(events).toHaveLength(1);
    expect(events[0]!.conversationId).toBe(conversationId);
    expect(events[0]!.conversationKey).toBe(conversationId);
  });

  test("does not set conversationKey on global events", async () => {
    const events = await collectEvents(() => {
      broadcastMessage({
        type: "conversation_list_invalidated",
        reason: "created",
      });
    });

    expect(events).toHaveLength(1);
    expect(events[0]!.conversationId).toBeUndefined();
    expect(events[0]!.conversationKey).toBeUndefined();
  });

  test("auto-extracts conversationId from message and sets conversationKey", async () => {
    const conversationId = "conv-xyz-789";
    const events = await collectEvents(() => {
      // No explicit conversationId arg — broadcastMessage extracts it from msg.
      broadcastMessage({
        type: "assistant_text_delta",
        text: "world",
        conversationId,
      });
    });

    expect(events).toHaveLength(1);
    expect(events[0]!.conversationId).toBe(conversationId);
    expect(events[0]!.conversationKey).toBe(conversationId);
  });
});
