import { describe, expect, test } from "bun:test";

import {
  buildSyncChangedMessage,
  conversationMessagesSyncTag,
  type ServerMessage,
  SYNC_TAGS,
  SyncChangedEventSchema,
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
      SyncChangedEventSchema.parse({
        type: "sync_changed",
        tags: [],
      }),
    ).toThrow();

    expect(() =>
      SyncChangedEventSchema.parse({
        type: "sync_changed",
        tags: [""],
      }),
    ).toThrow();
  });

  test("schema strips unknown server-stamped fields", () => {
    const parsed = SyncChangedEventSchema.parse({
      type: "sync_changed",
      tags: [SYNC_TAGS.assistantAvatar],
      cursor: 1,
    });

    expect(parsed).toEqual({
      type: "sync_changed",
      tags: [SYNC_TAGS.assistantAvatar],
    });
    expect("cursor" in parsed).toBe(false);
  });

  test("buildSyncChangedMessage includes originClientId when provided", () => {
    const message = buildSyncChangedMessage(
      [SYNC_TAGS.assistantAvatar],
      "client-abc",
    );

    expect(message).toEqual({
      type: "sync_changed",
      tags: [SYNC_TAGS.assistantAvatar],
      originClientId: "client-abc",
    });
  });

  test("buildSyncChangedMessage omits originClientId when undefined", () => {
    const message = buildSyncChangedMessage([SYNC_TAGS.assistantAvatar]);

    expect(message).toEqual({
      type: "sync_changed",
      tags: [SYNC_TAGS.assistantAvatar],
    });
    expect("originClientId" in message).toBe(false);
  });

  test("buildSyncChangedMessage trims and drops blank originClientId", () => {
    const blank = buildSyncChangedMessage([SYNC_TAGS.assistantAvatar], "   ");
    expect("originClientId" in blank).toBe(false);

    const trimmed = buildSyncChangedMessage(
      [SYNC_TAGS.assistantAvatar],
      "  client-xyz  ",
    );
    expect(trimmed).toEqual({
      type: "sync_changed",
      tags: [SYNC_TAGS.assistantAvatar],
      originClientId: "client-xyz",
    });
  });

  test("schema accepts a string originClientId and rejects non-string types", () => {
    expect(() =>
      SyncChangedEventSchema.parse({
        type: "sync_changed",
        tags: [SYNC_TAGS.assistantAvatar],
        originClientId: "client-abc",
      }),
    ).not.toThrow();

    expect(() =>
      SyncChangedEventSchema.parse({
        type: "sync_changed",
        tags: [SYNC_TAGS.assistantAvatar],
        originClientId: 42,
      }),
    ).toThrow();
  });
});
