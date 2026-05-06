import { beforeEach, describe, expect, test } from "bun:test";

import { SYNC_TAGS } from "../../daemon/message-types/sync.js";
import { getSqlite } from "../../memory/db-connection.js";
import { initializeDb } from "../../memory/db-init.js";
import { listSyncChangesSince } from "../../memory/sync-change-store.js";
import type { AssistantEvent } from "../assistant-event.js";
import { assistantEventHub } from "../assistant-event-hub.js";
import { publishSyncChanges } from "./sync-publisher.js";

initializeDb();

function clearSyncChanges(): void {
  getSqlite().run("DELETE FROM sync_changes");
  getSqlite().run("DELETE FROM sqlite_sequence WHERE name = 'sync_changes'");
}

beforeEach(() => {
  clearSyncChanges();
});

describe("sync publisher", () => {
  test("records changes before broadcasting sync_changed", async () => {
    const received: AssistantEvent[] = [];
    const subscription = assistantEventHub.subscribe({
      type: "process",
      callback: (event) => {
        received.push(event);
      },
    });

    try {
      const persisted = await publishSyncChanges(
        [
          {
            resource: "assistant",
            resourceId: "self",
            op: "updated",
            invalidatedTags: [SYNC_TAGS.assistantAvatar],
          },
        ],
        { originClientId: "client-1", createdAt: 1234 },
      );

      expect(persisted).toHaveLength(1);
      expect(listSyncChangesSince(0)).toHaveLength(1);
      expect(received).toHaveLength(1);
      expect(received[0].message).toMatchObject({
        type: "sync_changed",
        cursor: 1,
        tags: [SYNC_TAGS.assistantAvatar],
        originClientId: "client-1",
      });
    } finally {
      subscription.dispose();
    }
  });

  test("keeps durable storage when live publish fails", async () => {
    const subscription = assistantEventHub.subscribe({
      type: "process",
      callback: () => {
        throw new Error("subscriber failed");
      },
    });

    try {
      const persisted = await publishSyncChanges([
        {
          resource: "assistant",
          resourceId: "self",
          op: "updated",
          invalidatedTags: [SYNC_TAGS.assistantIdentity],
        },
      ]);

      expect(persisted).toHaveLength(1);
      expect(listSyncChangesSince(0)).toHaveLength(1);
    } finally {
      subscription.dispose();
    }
  });
});
