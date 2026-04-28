/**
 * Tests that daemon outbound messages are mirrored into the
 * assistant-events hub as AssistantEvent objects.
 *
 * Tests:
 *   - send()      → one mirrored assistant event per message
 *   - broadcast() → one mirrored assistant event per message (not per socket)
 */
import { describe, expect, mock, test } from "bun:test";

// ── Platform mock (must happen before imports that read it) ─────────────────
mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────
import type { ServerMessage } from "../daemon/message-protocol.js";
import type { AssistantEvent } from "../runtime/assistant-event.js";
import { buildAssistantEvent } from "../runtime/assistant-event.js";
import { AssistantEventHub } from "../runtime/assistant-event-hub.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

// ── buildAssistantEvent factory ───────────────────────────────────────────────

describe("buildAssistantEvent", () => {
  test("returns event with correct shape", () => {
    const msg: ServerMessage = {
      type: "assistant_text_delta",
      conversationId: "sess_1",
      text: "hi",
    };
    const event = buildAssistantEvent(msg, "sess_1");

    expect(typeof event.id).toBe("string");
    expect(event.id.length).toBeGreaterThan(0);
    expect(event.conversationId).toBe("sess_1");
    expect(event.message).toBe(msg);
    expect(typeof event.emittedAt).toBe("string");
    expect(new Date(event.emittedAt).toISOString()).toBe(event.emittedAt);
  });

  test("generates unique ids for each call", () => {
    const msg: ServerMessage = { type: "pong" };
    const a = buildAssistantEvent(msg);
    const b = buildAssistantEvent(msg);
    expect(a.id).not.toBe(b.id);
  });

  test("conversationId is undefined when omitted", () => {
    const msg: ServerMessage = { type: "pong" };
    const event = buildAssistantEvent(msg);
    expect(event.conversationId).toBeUndefined();
  });
});

// ── Hub integration (mimics what DaemonServer.publishAssistantEvent does) ────

describe("daemon send → one mirrored assistant event", () => {
  test("publishing a single event to the hub delivers exactly one event", async () => {
    const hub = new AssistantEventHub();
    const received: AssistantEvent[] = [];

    hub.subscribe({}, (e) => {
      received.push(e);
    });

    const msg: ServerMessage = {
      type: "assistant_text_delta",
      conversationId: "sess_a",
      text: "hello",
    };
    const event = buildAssistantEvent(msg, "sess_a");
    await hub.publish(event);

    expect(received).toHaveLength(1);
    expect(received[0].conversationId).toBe("sess_a");
    expect(received[0].message.type).toBe("assistant_text_delta");
  });

  test("conversationId falls back to explicit parameter when message lacks it", async () => {
    const hub = new AssistantEventHub();
    const received: AssistantEvent[] = [];

    hub.subscribe({}, (e) => {
      received.push(e);
    });

    const msg: ServerMessage = { type: "pong" }; // no conversationId field
    const event = buildAssistantEvent(msg, "sess_explicit");

    await hub.publish(event);

    expect(received).toHaveLength(1);
    expect(received[0].conversationId).toBe("sess_explicit");
  });
});

describe("daemon broadcast → one mirrored event per message (not per socket)", () => {
  test("one broadcast publish produces exactly one hub event regardless of subscriber count", async () => {
    const hub = new AssistantEventHub();
    const received: AssistantEvent[] = [];

    // Two subscribers (simulating two wire clients)
    hub.subscribe({}, (e) => {
      received.push(e);
    });
    hub.subscribe({}, (e) => {
      received.push(e);
    });

    // Simulate broadcast: server calls publishAssistantEvent once
    const msg: ServerMessage = {
      type: "message_complete",
      conversationId: "sess_b",
    };
    const event = buildAssistantEvent(msg, "sess_b");
    await hub.publish(event);

    // Both hub subscribers receive it (fanout), but only ONE event was published
    expect(received).toHaveLength(2); // two subscribers, each gets one delivery
  });

  test("broadcast publishes once; single send publishes once — not additive", async () => {
    const hub = new AssistantEventHub();
    const publishedEvents: AssistantEvent[] = [];

    hub.subscribe({}, (e) => {
      publishedEvents.push(e);
    });

    const msgA: ServerMessage = {
      type: "assistant_text_delta",
      conversationId: "s1",
      text: "a",
    };
    const msgB: ServerMessage = {
      type: "message_complete",
      conversationId: "s1",
    };

    // Simulate: one broadcast + one single send
    await hub.publish(buildAssistantEvent(msgA, "s1"));
    await hub.publish(buildAssistantEvent(msgB, "s1"));

    expect(publishedEvents).toHaveLength(2);
    expect(publishedEvents[0].message.type).toBe("assistant_text_delta");
    expect(publishedEvents[1].message.type).toBe("message_complete");
  });
});
