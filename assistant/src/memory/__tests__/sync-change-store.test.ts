import { beforeEach, describe, expect, test } from "bun:test";

import {
  conversationMessagesSyncTag,
  SYNC_TAGS,
} from "../../daemon/message-types/sync.js";
import { getSqlite } from "../db-connection.js";
import { initializeDb } from "../db-init.js";
import {
  getSyncCursorState,
  listSyncChangesSince,
  pruneSyncChangesToRetention,
  recordSyncChanges,
} from "../sync-change-store.js";

initializeDb();

function clearSyncChanges(): void {
  getSqlite().run("DELETE FROM sync_changes");
  getSqlite().run("DELETE FROM sqlite_sequence WHERE name = 'sync_changes'");
}

beforeEach(() => {
  clearSyncChanges();
});

describe("sync change store", () => {
  test("records a batch with monotonic cursors", () => {
    const changes = recordSyncChanges(
      [
        {
          resource: "assistant",
          resourceId: "self",
          op: "updated",
          invalidatedTags: [SYNC_TAGS.assistantAvatar],
        },
        {
          resource: "conversation",
          resourceId: "conv-1",
          op: "invalidated",
          invalidatedTags: [conversationMessagesSyncTag("conv-1")],
        },
      ],
      { createdAt: 1234 },
    );

    expect(changes).toHaveLength(2);
    expect(changes[0].cursor).toBe(1);
    expect(changes[1].cursor).toBe(2);
    expect(changes.map((change) => change.createdAt)).toEqual([1234, 1234]);

    const listed = listSyncChangesSince(0);
    expect(listed.map((change) => change.cursor)).toEqual([1, 2]);
  });

  test("round trips optional version, origin client, tags, and metadata", () => {
    const [change] = recordSyncChanges(
      [
        {
          resource: "assistant",
          resourceId: "self",
          op: "updated",
          version: 7,
          invalidatedTags: [
            SYNC_TAGS.assistantIdentity,
            SYNC_TAGS.assistantConfig,
          ],
          metadata: { reason: "settings-save" },
        },
      ],
      { originClientId: "client-1", createdAt: 5678 },
    );

    expect(change).toMatchObject({
      cursor: 1,
      createdAt: 5678,
      resource: "assistant",
      resourceId: "self",
      op: "updated",
      version: 7,
      originClientId: "client-1",
      metadata: { reason: "settings-save" },
    });
    expect(change.invalidatedTags).toEqual([
      SYNC_TAGS.assistantIdentity,
      SYNC_TAGS.assistantConfig,
    ]);
  });

  test("lists changes after a cursor with a bounded limit", () => {
    recordSyncChanges([
      {
        resource: "assistant",
        resourceId: "self",
        op: "updated",
        invalidatedTags: [SYNC_TAGS.assistantAvatar],
      },
      {
        resource: "assistant",
        resourceId: "self",
        op: "updated",
        invalidatedTags: [SYNC_TAGS.assistantIdentity],
      },
      {
        resource: "conversations",
        resourceId: "list",
        op: "invalidated",
        invalidatedTags: [SYNC_TAGS.conversationsList],
      },
    ]);

    const page = listSyncChangesSince(1, 1);
    expect(page).toHaveLength(1);
    expect(page[0].cursor).toBe(2);
  });

  test("reports latest cursor and retention floor", () => {
    recordSyncChanges([
      {
        resource: "assistant",
        resourceId: "self",
        op: "updated",
        invalidatedTags: [SYNC_TAGS.assistantAvatar],
      },
      {
        resource: "assistant",
        resourceId: "self",
        op: "updated",
        invalidatedTags: [SYNC_TAGS.assistantIdentity],
      },
    ]);

    expect(getSyncCursorState()).toEqual({
      latestCursor: 2,
      oldestCursor: 1,
      retentionFloorCursor: 0,
    });

    getSqlite().run("DELETE FROM sync_changes WHERE cursor = 1");
    expect(getSyncCursorState()).toEqual({
      latestCursor: 2,
      oldestCursor: 2,
      retentionFloorCursor: 1,
    });
  });

  test("prunes to retained row count", () => {
    recordSyncChanges([
      {
        resource: "assistant",
        resourceId: "self",
        op: "updated",
        invalidatedTags: [SYNC_TAGS.assistantAvatar],
      },
      {
        resource: "assistant",
        resourceId: "self",
        op: "updated",
        invalidatedTags: [SYNC_TAGS.assistantIdentity],
      },
      {
        resource: "conversations",
        resourceId: "list",
        op: "invalidated",
        invalidatedTags: [SYNC_TAGS.conversationsList],
      },
    ]);

    expect(pruneSyncChangesToRetention(2)).toBe(1);
    expect(listSyncChangesSince(0).map((change) => change.cursor)).toEqual([
      2, 3,
    ]);
  });

  test("applies retention after recording changes", () => {
    recordSyncChanges(
      [
        {
          resource: "assistant",
          resourceId: "self",
          op: "updated",
          invalidatedTags: [SYNC_TAGS.assistantAvatar],
        },
        {
          resource: "assistant",
          resourceId: "self",
          op: "updated",
          invalidatedTags: [SYNC_TAGS.assistantIdentity],
        },
        {
          resource: "conversations",
          resourceId: "list",
          op: "invalidated",
          invalidatedTags: [SYNC_TAGS.conversationsList],
        },
      ],
      { retentionRows: 2 },
    );

    expect(listSyncChangesSince(0).map((change) => change.cursor)).toEqual([
      2, 3,
    ]);
    expect(getSyncCursorState().retentionFloorCursor).toBe(1);
  });
});
