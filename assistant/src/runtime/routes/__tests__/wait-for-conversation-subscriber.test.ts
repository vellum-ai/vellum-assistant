import { describe, expect, test } from "bun:test";

import { AssistantEventHub } from "../../assistant-event-hub.js";
import { waitForConversationSubscriber } from "../conversation-routes.js";

describe("waitForConversationSubscriber", () => {
  test("resolves immediately when a subscriber is already present", async () => {
    /**
     * Tests that the common, already-connected case is unchanged: no polling
     * delay is introduced when a subscriber already exists.
     */

    // GIVEN a hub that already has a connected subscriber
    const hub = new AssistantEventHub();
    hub.subscribe({ type: "process", callback: () => {} });

    // WHEN we wait for a subscriber on a conversation
    const start = Date.now();
    const result = await waitForConversationSubscriber(
      "sess_1",
      1_000,
      10,
      hub,
    );

    // THEN it resolves true without sleeping for a poll interval
    expect(result).toBe(true);
    expect(Date.now() - start).toBeLessThan(50);
  });

  test("resolves once a subscriber appears mid-wait", async () => {
    /**
     * Tests the hatch race: the wait starts with no subscriber and resolves as
     * soon as the freshly-launched client's SSE subscription connects.
     */

    // GIVEN a hub with no subscriber yet
    const hub = new AssistantEventHub();

    // AND a subscriber that connects a few poll intervals later
    setTimeout(() => {
      hub.subscribe({
        type: "process",
        filter: { conversationId: "sess_1" },
        callback: () => {},
      });
    }, 30);

    // WHEN we wait for a subscriber on that conversation
    const result = await waitForConversationSubscriber(
      "sess_1",
      1_000,
      10,
      hub,
    );

    // THEN it resolves true once the subscriber appears
    expect(result).toBe(true);
  });

  test("returns false when no subscriber connects before the cap", async () => {
    /**
     * Tests that the wait is bounded: when nobody connects, it gives up after
     * the timeout so the caller falls through to the immediate broadcast.
     */

    // GIVEN a hub that never gains a subscriber
    const hub = new AssistantEventHub();

    // WHEN we wait with a short cap
    const start = Date.now();
    const result = await waitForConversationSubscriber("sess_1", 60, 10, hub);

    // THEN it resolves false at/after the cap
    expect(result).toBe(false);
    expect(Date.now() - start).toBeGreaterThanOrEqual(55);
  });

  test("ignores subscribers scoped to a different conversation", async () => {
    /**
     * Tests that conversation scoping is honored: a subscriber on an unrelated
     * conversation does not satisfy the wait.
     */

    // GIVEN a hub whose only subscriber is scoped to a different conversation
    const hub = new AssistantEventHub();
    hub.subscribe({
      type: "process",
      filter: { conversationId: "sess_other" },
      callback: () => {},
    });

    // WHEN we wait for a subscriber on sess_1
    const result = await waitForConversationSubscriber("sess_1", 60, 10, hub);

    // THEN it times out because no matching subscriber exists
    expect(result).toBe(false);
  });
});
