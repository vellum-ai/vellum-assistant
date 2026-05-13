import { describe, expect, test } from "bun:test";

import { SYNC_TAGS } from "../daemon/message-types/sync.js";
import type { AssistantEvent } from "../runtime/assistant-event.js";
import { assistantEventHub } from "../runtime/assistant-event-hub.js";
import {
  publishConfigChanged,
  publishSchedulesChanged,
  publishSoundsConfigUpdated,
} from "../runtime/sync/resource-sync-events.js";

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for config/sounds sync event");
}

describe("config and sounds sync events", () => {
  test("config changes emit legacy config event and sync tag", async () => {
    const received: AssistantEvent[] = [];
    const subscription = assistantEventHub.subscribe({
      type: "process",
      callback: (event) => {
        received.push(event);
      },
    });

    try {
      publishConfigChanged();
      await waitFor(() => received.length === 2);

      expect(received.map((event) => event.message.type)).toEqual([
        "config_changed",
        "sync_changed",
      ]);
      expect(received[1].message).toEqual({
        type: "sync_changed",
        tags: [SYNC_TAGS.assistantConfig],
      });
    } finally {
      subscription.dispose();
    }
  });

  test("sounds config changes emit legacy sounds event and sync tag", async () => {
    const received: AssistantEvent[] = [];
    const subscription = assistantEventHub.subscribe({
      type: "process",
      callback: (event) => {
        received.push(event);
      },
    });

    try {
      publishSoundsConfigUpdated();
      await waitFor(() => received.length === 2);

      expect(received.map((event) => event.message.type)).toEqual([
        "sounds_config_updated",
        "sync_changed",
      ]);
      expect(received[1].message).toEqual({
        type: "sync_changed",
        tags: [SYNC_TAGS.assistantSounds],
      });
    } finally {
      subscription.dispose();
    }
  });

  test("schedule changes emit a sync tag", async () => {
    const received: AssistantEvent[] = [];
    const subscription = assistantEventHub.subscribe({
      type: "process",
      callback: (event) => {
        received.push(event);
      },
    });

    try {
      publishSchedulesChanged();
      await waitFor(() => received.length === 1);

      expect(received[0].message).toEqual({
        type: "sync_changed",
        tags: [SYNC_TAGS.assistantSchedules],
      });
    } finally {
      subscription.dispose();
    }
  });
});
