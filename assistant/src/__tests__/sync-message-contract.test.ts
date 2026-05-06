import { describe, expect, test } from "bun:test";

import type {
  ServerMessage,
  SyncChangedMessage,
} from "../daemon/message-protocol.js";
import {
  buildSyncChangedMessage,
  conversationMessagesSyncTag,
  SYNC_TAGS,
  SyncChangedMessageSchema,
} from "../daemon/message-protocol.js";

describe("sync message contract", () => {
  test("sync_changed is assignable to ServerMessage", () => {
    const msg: SyncChangedMessage = {
      type: "sync_changed",
      cursor: 2,
      tags: [SYNC_TAGS.assistantAvatar],
      changes: [
        {
          cursor: 2,
          createdAt: 1_700_000_000_000,
          resource: "assistant",
          resourceId: "self",
          op: "updated",
          invalidatedTags: [SYNC_TAGS.assistantAvatar],
        },
      ],
    };

    const serverMessage: ServerMessage = msg;
    expect(serverMessage.type).toBe("sync_changed");
  });

  test("buildSyncChangedMessage aggregates cursors and tags for batches", () => {
    const msg = buildSyncChangedMessage([
      {
        cursor: 10,
        createdAt: 1,
        resource: "assistant",
        resourceId: "self",
        op: "updated",
        invalidatedTags: [SYNC_TAGS.assistantIdentity],
      },
      {
        cursor: 11,
        createdAt: 1,
        resource: "conversation",
        resourceId: "conv-1",
        op: "invalidated",
        invalidatedTags: [
          SYNC_TAGS.conversationsList,
          conversationMessagesSyncTag("conv-1"),
        ],
      },
    ]);

    expect(msg.cursor).toBe(11);
    expect(msg.tags).toEqual([
      SYNC_TAGS.assistantIdentity,
      SYNC_TAGS.conversationsList,
      "conversation:conv-1:messages",
    ]);
    expect(SyncChangedMessageSchema.safeParse(msg).success).toBe(true);
  });

  test("schema rejects malformed sync_changed payloads", () => {
    expect(
      SyncChangedMessageSchema.safeParse({
        type: "sync_changed",
        cursor: 1,
        tags: [],
        changes: [],
      }).success,
    ).toBe(false);

    expect(
      SyncChangedMessageSchema.safeParse({
        type: "sync_changed",
        cursor: "1",
        tags: [SYNC_TAGS.assistantAvatar],
        changes: [
          {
            cursor: 1,
            createdAt: 1,
            resource: "assistant",
            resourceId: "self",
            op: "updated",
            invalidatedTags: [SYNC_TAGS.assistantAvatar],
          },
        ],
      }).success,
    ).toBe(false);

    expect(
      SyncChangedMessageSchema.safeParse({
        type: "sync_changed",
        cursor: 1,
        tags: [SYNC_TAGS.assistantAvatar],
        changes: [
          {
            cursor: 1,
            createdAt: 1,
            resource: "assistant",
            resourceId: "self",
            op: "replaced",
            invalidatedTags: [SYNC_TAGS.assistantAvatar],
          },
        ],
      }).success,
    ).toBe(false);
  });
});
