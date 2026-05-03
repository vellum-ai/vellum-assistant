/**
 * Tests for targeted delivery in AssistantEventHub.
 *
 * Validates:
 *   - hub.publish(event, { targetClientId }) delivers only to the named client,
 *     even when that subscriber's filter.conversationId doesn't match.
 *   - hub.publish(event, { targetClientId }) does NOT deliver to other clients.
 *   - hub.publish(event, { targetClientId, targetCapability }) skips subscribers
 *     that don't have the required capability.
 *   - hub.publish(event, { targetCapability }) (untargeted) still applies
 *     conversation scoping normally.
 *   - getClientById() returns the correct entry or undefined.
 */
import { describe, expect, test } from "bun:test";

import type { AssistantEvent } from "../runtime/assistant-event.js";
import { AssistantEventHub } from "../runtime/assistant-event-hub.js";

function makeEvent(overrides: Partial<AssistantEvent> = {}): AssistantEvent {
  return {
    id: "evt_test",
    conversationId: "sess_web",
    emittedAt: "2026-05-03T00:00:00.000Z",
    message: {
      type: "assistant_text_delta",
      conversationId: "sess_web",
      text: "hi",
    },
    ...overrides,
  };
}

// ── Targeted delivery ─────────────────────────────────────────────────────────

describe("AssistantEventHub — targeted delivery (targetClientId)", () => {
  test("delivers only to the named client, bypassing conversation filter", async () => {
    const hub = new AssistantEventHub();
    const receivedA: AssistantEvent[] = [];
    const receivedB: AssistantEvent[] = [];

    // client-a is subscribed to "sess_macos" — different from the event's "sess_web"
    hub.subscribe({
      type: "client",
      clientId: "client-a",
      interfaceId: "macos",
      capabilities: ["host_bash"],
      filter: { conversationId: "sess_macos" },
      callback: (e) => {
        receivedA.push(e);
      },
    });

    // client-b is subscribed to "sess_web" — same as the event's conversationId
    hub.subscribe({
      type: "client",
      clientId: "client-b",
      interfaceId: "macos",
      capabilities: ["host_bash"],
      filter: { conversationId: "sess_web" },
      callback: (e) => {
        receivedB.push(e);
      },
    });

    // Target client-a specifically — should bypass its conversation filter
    await hub.publish(makeEvent({ conversationId: "sess_web" }), {
      targetClientId: "client-a",
    });

    // client-a receives it despite mismatched conversationId
    expect(receivedA).toHaveLength(1);
    // client-b does NOT receive it even though its conversationId matches
    expect(receivedB).toHaveLength(0);
  });

  test("does not deliver to a client with a different clientId", async () => {
    const hub = new AssistantEventHub();
    const receivedA: AssistantEvent[] = [];
    const receivedB: AssistantEvent[] = [];

    hub.subscribe({
      type: "client",
      clientId: "client-a",
      interfaceId: "macos",
      capabilities: ["host_bash"],
      callback: (e) => {
        receivedA.push(e);
      },
    });

    hub.subscribe({
      type: "client",
      clientId: "client-b",
      interfaceId: "macos",
      capabilities: ["host_bash"],
      callback: (e) => {
        receivedB.push(e);
      },
    });

    await hub.publish(makeEvent(), { targetClientId: "client-a" });

    expect(receivedA).toHaveLength(1);
    expect(receivedB).toHaveLength(0);
  });

  test("targeted delivery with wrong capability does not deliver", async () => {
    const hub = new AssistantEventHub();
    const receivedA: AssistantEvent[] = [];

    // client-a only has host_file capability, NOT host_bash
    hub.subscribe({
      type: "client",
      clientId: "client-a",
      interfaceId: "macos",
      capabilities: ["host_file"],
      callback: (e) => {
        receivedA.push(e);
      },
    });

    await hub.publish(makeEvent(), {
      targetClientId: "client-a",
      targetCapability: "host_bash",
    });

    // client-a is the target but lacks the required capability — not delivered
    expect(receivedA).toHaveLength(0);
  });

  test("targeted delivery with matching capability delivers", async () => {
    const hub = new AssistantEventHub();
    const receivedA: AssistantEvent[] = [];

    hub.subscribe({
      type: "client",
      clientId: "client-a",
      interfaceId: "macos",
      capabilities: ["host_bash"],
      callback: (e) => {
        receivedA.push(e);
      },
    });

    await hub.publish(makeEvent(), {
      targetClientId: "client-a",
      targetCapability: "host_bash",
    });

    expect(receivedA).toHaveLength(1);
  });

  test("process-type subscriber is never matched by targetClientId", async () => {
    const hub = new AssistantEventHub();
    const received: AssistantEvent[] = [];

    hub.subscribe({
      type: "process",
      callback: (e) => {
        received.push(e);
      },
    });

    await hub.publish(makeEvent(), { targetClientId: "some-client" });

    // Process subscribers have no clientId — they should never receive targeted events
    expect(received).toHaveLength(0);
  });
});

// ── Untargeted delivery unchanged ─────────────────────────────────────────────

describe("AssistantEventHub — untargeted capability targeting is unchanged", () => {
  test("targetCapability without targetClientId still applies conversation scoping", async () => {
    const hub = new AssistantEventHub();
    const receivedA: AssistantEvent[] = [];
    const receivedB: AssistantEvent[] = [];

    hub.subscribe({
      type: "client",
      clientId: "client-a",
      interfaceId: "macos",
      capabilities: ["host_bash"],
      filter: { conversationId: "sess_A" },
      callback: (e) => {
        receivedA.push(e);
      },
    });

    hub.subscribe({
      type: "client",
      clientId: "client-b",
      interfaceId: "macos",
      capabilities: ["host_bash"],
      filter: { conversationId: "sess_B" },
      callback: (e) => {
        receivedB.push(e);
      },
    });

    await hub.publish(makeEvent({ conversationId: "sess_A" }), {
      targetCapability: "host_bash",
    });

    expect(receivedA).toHaveLength(1);
    expect(receivedB).toHaveLength(0);
  });
});

// ── getClientById ─────────────────────────────────────────────────────────────

describe("AssistantEventHub — getClientById()", () => {
  test("returns the client entry for the given clientId", () => {
    const hub = new AssistantEventHub();

    hub.subscribe({
      type: "client",
      clientId: "client-x",
      interfaceId: "macos",
      capabilities: ["host_bash"],
      callback: () => {},
    });

    const entry = hub.getClientById("client-x");
    expect(entry).toBeDefined();
    expect(entry?.clientId).toBe("client-x");
  });

  test("returns undefined when no client has the given clientId", () => {
    const hub = new AssistantEventHub();

    hub.subscribe({
      type: "client",
      clientId: "client-x",
      interfaceId: "macos",
      capabilities: ["host_bash"],
      callback: () => {},
    });

    expect(hub.getClientById("client-y")).toBeUndefined();
  });

  test("returns undefined after the subscriber is disposed", () => {
    const hub = new AssistantEventHub();

    const sub = hub.subscribe({
      type: "client",
      clientId: "client-x",
      interfaceId: "macos",
      capabilities: ["host_bash"],
      callback: () => {},
    });

    sub.dispose();
    expect(hub.getClientById("client-x")).toBeUndefined();
  });
});
