import { describe, expect, test } from "bun:test";

import { AssistantEventHub } from "../../assistant-event-hub.js";
import { waitForConversationSubscriber } from "../conversation-routes.js";

function subscribeClient(
  hub: AssistantEventHub,
  conversationId?: string,
): void {
  hub.subscribe({
    type: "client",
    clientId: `client-${Math.random().toString(36).slice(2)}`,
    interfaceId: "macos",
    capabilities: [],
    filter: conversationId ? { conversationId } : undefined,
    callback: () => {},
  });
}

describe("waitForConversationSubscriber", () => {
  test("resolves immediately when a client subscriber is already present", async () => {
    /**
     * Tests that the common, already-connected case is unchanged: no polling
     * delay is introduced when a client subscriber already exists.
     */

    // GIVEN a hub that already has a connected client subscriber
    const hub = new AssistantEventHub();
    subscribeClient(hub);

    // WHEN we wait for a subscriber on a conversation
    const start = Date.now();
    const result = await waitForConversationSubscriber(
      "sess_1",
      1_000,
      hub,
      10,
    );

    // THEN it resolves true without sleeping for a poll interval
    expect(result).toBe(true);
    expect(Date.now() - start).toBeLessThan(50);
  });

  test("resolves once a client subscriber appears mid-wait", async () => {
    /**
     * Tests the hatch race: the wait starts with no client and resolves as soon
     * as the freshly-launched client's SSE subscription connects.
     */

    // GIVEN a hub with no subscriber yet
    const hub = new AssistantEventHub();

    // AND a client that connects a few poll intervals later
    setTimeout(() => subscribeClient(hub, "sess_1"), 30);

    // WHEN we wait for a subscriber on that conversation
    const result = await waitForConversationSubscriber(
      "sess_1",
      1_000,
      hub,
      10,
    );

    // THEN it resolves true once the client appears
    expect(result).toBe(true);
  });

  test("returns false when no client connects before the cap", async () => {
    /**
     * Tests that the wait is bounded: when nobody connects, it gives up after
     * the timeout so the caller falls through to the immediate broadcast.
     */

    // GIVEN a hub that never gains a subscriber
    const hub = new AssistantEventHub();

    // WHEN we wait with a short cap
    const start = Date.now();
    const result = await waitForConversationSubscriber("sess_1", 60, hub, 10);

    // THEN it resolves false at/after the cap
    expect(result).toBe(false);
    expect(Date.now() - start).toBeGreaterThanOrEqual(55);
  });

  test("ignores client subscribers scoped to a different conversation", async () => {
    /**
     * Tests that conversation scoping is honored: a client on an unrelated
     * conversation does not satisfy the wait.
     */

    // GIVEN a hub whose only client is scoped to a different conversation
    const hub = new AssistantEventHub();
    subscribeClient(hub, "sess_other");

    // WHEN we wait for a subscriber on sess_1
    const result = await waitForConversationSubscriber("sess_1", 60, hub, 10);

    // THEN it times out because no matching client exists
    expect(result).toBe(false);
  });

  test("ignores in-process (non-client) subscribers", async () => {
    /**
     * Tests that a `process` subscriber (e.g. a skill watcher) does NOT satisfy
     * the wait. Only a client SSE connection can clear the hatch spinner, so
     * counting a process subscriber as "connected" would re-open the race.
     */

    // GIVEN a hub whose only subscriber is an in-process consumer
    const hub = new AssistantEventHub();
    hub.subscribe({
      type: "process",
      filter: { conversationId: "sess_1" },
      callback: () => {},
    });

    // WHEN we wait for a subscriber on that conversation
    const result = await waitForConversationSubscriber("sess_1", 60, hub, 10);

    // THEN it times out because no client is connected
    expect(result).toBe(false);
  });
});
