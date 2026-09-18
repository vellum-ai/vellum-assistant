import { describe, expect, test } from "bun:test";

import { normalizeConnectionsDelivery } from "./normalize.js";

function delivery(overrides: Record<string, unknown> = {}) {
  return {
    eventId: "evt-123",
    issuedAt: 1_700_000_000,
    threadId: "thread-abc",
    sender: { userId: "user-123", displayName: "Alice", username: "alice" },
    text: "Hi, can you help me with something?",
    ...overrides,
  };
}

describe("normalizeConnectionsDelivery", () => {
  test("keys the event on the sender's user id and the platform thread", () => {
    const payload = delivery();
    const normalized = normalizeConnectionsDelivery(payload);

    expect(normalized).not.toBeNull();
    expect(normalized?.eventId).toBe("evt-123");
    expect(normalized?.issuedAt).toBe(1_700_000_000);

    const event = normalized!.event;
    expect(event.sourceChannel).toBe("connections");
    expect(event.actor.actorExternalId).toBe("user-123");
    expect(event.actor.displayName).toBe("Alice");
    expect(event.actor.username).toBe("alice");
    expect(event.message.conversationExternalId).toBe("thread-abc");
    expect(event.message.externalMessageId).toBe("evt-123");
    expect(event.message.content).toBe("Hi, can you help me with something?");
    expect(event.message.eventKind).toBe("message");
    expect(event.raw).toEqual(payload);
  });

  test("marks every delivery as a direct message", () => {
    const event = normalizeConnectionsDelivery(delivery())!.event;

    expect(event.source.isDirectMessage).toBe(true);
    expect(event.source.conversationType).toBe("dm");
    expect(event.source.chatType).toBe("dm");
  });

  test("drops a malformed display field but keeps the message", () => {
    const normalized = normalizeConnectionsDelivery(
      delivery({ sender: { userId: "user-123", displayName: 42 } }),
    );

    expect(normalized?.event.actor.actorExternalId).toBe("user-123");
    expect(normalized?.event.actor.displayName).toBeUndefined();
  });

  test.each([
    ["eventId", { eventId: "" }],
    ["issuedAt", { issuedAt: "yesterday" }],
    ["threadId", { threadId: undefined }],
    ["sender.userId", { sender: { displayName: "Alice" } }],
    ["text", { text: "" }],
  ])("rejects a delivery without a usable %s", (_field, overrides) => {
    expect(normalizeConnectionsDelivery(delivery(overrides))).toBeNull();
  });

  test.each([[null], ["a string"], [["an", "array"]], [42]])(
    "rejects a payload that is not an object: %p",
    (payload) => {
      expect(normalizeConnectionsDelivery(payload)).toBeNull();
    },
  );
});
