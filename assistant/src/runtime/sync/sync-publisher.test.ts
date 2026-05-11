import { describe, expect, test } from "bun:test";

import { SYNC_TAGS } from "../../daemon/message-types/sync.js";
import type { AssistantEvent } from "../assistant-event.js";
import { assistantEventHub } from "../assistant-event-hub.js";
import { publishSyncInvalidation } from "./sync-publisher.js";

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
    const subscription = assistantEventHub.subscribe({
      type: "process",
      callback: () => {
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
    } finally {
      subscription.dispose();
    }
  });
});
