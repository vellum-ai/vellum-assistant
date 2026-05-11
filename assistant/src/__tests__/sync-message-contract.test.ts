import { describe, expect, test } from "bun:test";

import {
  buildSyncChangedMessage,
  conversationMessagesSyncTag,
  type ServerMessage,
  SYNC_TAGS,
  SyncChangedMessageSchema,
} from "../daemon/message-protocol.js";

describe("sync message contract", () => {
  test("sync_changed is assignable to ServerMessage", () => {
    const message: ServerMessage = {
      type: "sync_changed",
      tags: [SYNC_TAGS.assistantAvatar],
    };

    expect(message).toEqual({
      type: "sync_changed",
      tags: [SYNC_TAGS.assistantAvatar],
    });
  });

  test("buildSyncChangedMessage dedupes tags", () => {
    const message = buildSyncChangedMessage([
      SYNC_TAGS.assistantAvatar,
      SYNC_TAGS.assistantAvatar,
      conversationMessagesSyncTag("conversation-123"),
    ]);

    expect(message).toEqual({
      type: "sync_changed",
      tags: [
        SYNC_TAGS.assistantAvatar,
        "conversation:conversation-123:messages",
      ],
    });
  });

  test("schema rejects malformed sync_changed payloads", () => {
    expect(() =>
      SyncChangedMessageSchema.parse({
        type: "sync_changed",
        tags: [],
      }),
    ).toThrow();

    expect(() =>
      SyncChangedMessageSchema.parse({
        type: "sync_changed",
        tags: [""],
      }),
    ).toThrow();

    expect(() =>
      SyncChangedMessageSchema.parse({
        type: "sync_changed",
        tags: [SYNC_TAGS.assistantAvatar],
        cursor: 1,
      }),
    ).toThrow();
  });
});
