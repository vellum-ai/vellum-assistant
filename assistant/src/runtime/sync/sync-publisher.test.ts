import { describe, expect, test } from "bun:test";

import { SYNC_TAGS } from "../../daemon/message-types/sync.js";
import type { AssistantEvent } from "../assistant-event.js";
import { assistantEventHub, broadcastMessage } from "../assistant-event-hub.js";
import { publishSyncInvalidation } from "./sync-publisher.js";

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for sync publisher test condition");
}

describe("sync publisher", () => {
  test("publishes a deduped sync_changed event", async () => {
    const received: AssistantEvent[] = [];
    const subscription = assistantEventHub.subscribe({
      type: "process",
      callback: (event) => {
        received.push(event);
      },
    });

    try {
      const message = await publishSyncInvalidation([
        SYNC_TAGS.assistantAvatar,
        SYNC_TAGS.assistantAvatar,
        SYNC_TAGS.assistantIdentity,
      ]);

      await waitFor(() => received.length === 1);

      expect(message).toEqual({
        type: "sync_changed",
        tags: [SYNC_TAGS.assistantAvatar, SYNC_TAGS.assistantIdentity],
      });
      expect(received).toHaveLength(1);
      expect(received[0].message).toEqual(message);
    } finally {
      subscription.dispose();
    }
  });

  test("rejects empty tag lists before publishing", async () => {
    await expect(publishSyncInvalidation([])).rejects.toThrow();
  });

  test("does not fail the caller when live publish fails", async () => {
    let callbackCalled = false;
    const subscription = assistantEventHub.subscribe({
      type: "process",
      callback: () => {
        callbackCalled = true;
        throw new Error("subscriber failed");
      },
    });

    try {
      await expect(
        publishSyncInvalidation([SYNC_TAGS.assistantAvatar]),
      ).resolves.toEqual({
        type: "sync_changed",
        tags: [SYNC_TAGS.assistantAvatar],
      });
      await waitFor(() => callbackCalled);
    } finally {
      subscription.dispose();
    }
  });

  test("preserves ordering with previously queued server events", async () => {
    const receivedTypes: string[] = [];
    const subscription = assistantEventHub.subscribe({
      type: "process",
      callback: async (event) => {
        if (event.message.type === "conversation_list_invalidated") {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        receivedTypes.push(event.message.type);
      },
    });

    try {
      broadcastMessage({
        type: "conversation_list_invalidated",
        reason: "created",
      });
      await publishSyncInvalidation([SYNC_TAGS.conversationsList]);

      await waitFor(() => receivedTypes.length === 2);

      expect(receivedTypes).toEqual([
        "conversation_list_invalidated",
        "sync_changed",
      ]);
    } finally {
      subscription.dispose();
    }
  });

  test("forwards originClientId when provided", async () => {
    const received: AssistantEvent[] = [];
    const subscription = assistantEventHub.subscribe({
      type: "process",
      callback: (event) => {
        received.push(event);
      },
    });

    try {
      const message = await publishSyncInvalidation(
        [SYNC_TAGS.assistantAvatar],
        "client-abc",
      );

      await waitFor(() => received.length === 1);

      expect(message).toEqual({
        type: "sync_changed",
        tags: [SYNC_TAGS.assistantAvatar],
        originClientId: "client-abc",
      });
      expect(received[0].message).toEqual(message);
    } finally {
      subscription.dispose();
    }
  });

  test("omits originClientId when not provided", async () => {
    const received: AssistantEvent[] = [];
    const subscription = assistantEventHub.subscribe({
      type: "process",
      callback: (event) => {
        received.push(event);
      },
    });

    try {
      const message = await publishSyncInvalidation([SYNC_TAGS.assistantAvatar]);

      await waitFor(() => received.length === 1);

      expect("originClientId" in message).toBe(false);
      expect(received[0].message).toEqual(message);
    } finally {
      subscription.dispose();
    }
  });
});
