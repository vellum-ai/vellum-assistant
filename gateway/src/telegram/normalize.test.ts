import { describe, it, expect } from "bun:test";
import { normalizeTelegramUpdate } from "./normalize.js";

function makeCallbackQueryPayload(overrides?: {
  chatType?: string;
  chatId?: number;
  data?: string;
  fromId?: number;
}) {
  const hasChatType = overrides !== undefined && "chatType" in overrides;
  return {
    update_id: 100,
    callback_query: {
      id: "cbq-1",
      from: { id: overrides?.fromId ?? 42, first_name: "Alice" },
      message: {
        message_id: 10,
        chat: {
          id: overrides?.chatId ?? 42,
          type: hasChatType ? overrides!.chatType : "private",
        },
      },
      data: overrides?.data ?? "apr:run1:approve",
    },
  };
}

describe("normalizeTelegramUpdate — private-chat topics", () => {
  it("maps message_thread_id to source.threadId", () => {
    const result = normalizeTelegramUpdate({
      update_id: 500,
      message: {
        message_id: 50,
        message_thread_id: 777,
        text: "hello topic",
        chat: { id: 42, type: "private" },
        from: { id: 42, first_name: "Alice" },
      },
    });

    expect(result).not.toBeNull();
    expect(result!.source.threadId).toBe("777");
    expect(result!.message.content).toBe("hello topic");
  });

  it("leaves source.threadId undefined for messages outside a topic", () => {
    const result = normalizeTelegramUpdate({
      update_id: 501,
      message: {
        message_id: 51,
        text: "plain dm",
        chat: { id: 42, type: "private" },
        from: { id: 42, first_name: "Alice" },
      },
    });

    expect(result).not.toBeNull();
    expect(result!.source.threadId).toBeUndefined();
  });

  it("maps callback_query message_thread_id to source.threadId", () => {
    const result = normalizeTelegramUpdate({
      update_id: 502,
      callback_query: {
        id: "cbq-topic",
        from: { id: 42, first_name: "Alice" },
        message: {
          message_id: 52,
          message_thread_id: 777,
          chat: { id: 42, type: "private" },
        },
        data: "apr:run1:approve",
      },
    });

    expect(result).not.toBeNull();
    expect(result!.source.threadId).toBe("777");
  });

  it("still rejects group messages even when they carry message_thread_id", () => {
    const result = normalizeTelegramUpdate({
      update_id: 503,
      message: {
        message_id: 53,
        message_thread_id: 777,
        text: "forum topic message",
        chat: { id: -100123, type: "supergroup" },
        from: { id: 42, first_name: "Alice" },
      },
    });

    expect(result).toBeNull();
  });
});

describe("normalizeTelegramUpdate — callback_query DM-only guard", () => {
  it("accepts callback_query from private chat", () => {
    const result = normalizeTelegramUpdate(
      makeCallbackQueryPayload({ chatType: "private" }),
    );
    expect(result).not.toBeNull();
    expect(result!.message.callbackQueryId).toBe("cbq-1");
    expect(result!.message.callbackData).toBe("apr:run1:approve");
  });

  it("rejects callback_query from group chat", () => {
    const result = normalizeTelegramUpdate(
      makeCallbackQueryPayload({ chatType: "group" }),
    );
    expect(result).toBeNull();
  });

  it("rejects callback_query from supergroup chat", () => {
    const result = normalizeTelegramUpdate(
      makeCallbackQueryPayload({ chatType: "supergroup" }),
    );
    expect(result).toBeNull();
  });

  it("rejects callback_query from channel chat", () => {
    const result = normalizeTelegramUpdate(
      makeCallbackQueryPayload({ chatType: "channel" }),
    );
    expect(result).toBeNull();
  });

  it("rejects callback_query when chat type is undefined", () => {
    const result = normalizeTelegramUpdate(
      makeCallbackQueryPayload({ chatType: undefined as unknown as string }),
    );
    expect(result).toBeNull();
  });
});

function makeVoicePayload(overrides?: {
  chatType?: string;
  fromId?: number | null;
  caption?: string;
}) {
  return {
    update_id: 200,
    message: {
      message_id: 20,
      chat: { id: 42, type: overrides?.chatType ?? "private" },
      from:
        overrides?.fromId === null
          ? undefined
          : { id: overrides?.fromId ?? 42, first_name: "Alice" },
      ...(overrides?.caption ? { caption: overrides.caption } : {}),
      voice: {
        file_id: "voice-file-id-123",
        file_unique_id: "voice-unique-123",
        duration: 5,
        mime_type: "audio/ogg",
        file_size: 12345,
      },
    },
  };
}

function makeAudioPayload(overrides?: {
  chatType?: string;
  fromId?: number | null;
  caption?: string;
}) {
  return {
    update_id: 300,
    message: {
      message_id: 30,
      chat: { id: 42, type: overrides?.chatType ?? "private" },
      from:
        overrides?.fromId === null
          ? undefined
          : { id: overrides?.fromId ?? 42, first_name: "Alice" },
      ...(overrides?.caption ? { caption: overrides.caption } : {}),
      audio: {
        file_id: "audio-file-id-456",
        file_unique_id: "audio-unique-456",
        duration: 180,
        performer: "Artist",
        title: "Song Title",
        file_name: "song.mp3",
        mime_type: "audio/mpeg",
        file_size: 5000000,
      },
    },
  };
}

describe("normalizeTelegramUpdate — voice messages", () => {
  it("voice message produces an audio attachment with empty content", () => {
    const result = normalizeTelegramUpdate(makeVoicePayload());
    expect(result).not.toBeNull();
    expect(result!.message.content).toBe("");
    expect(result!.message.attachments).toEqual([
      {
        type: "audio",
        fileId: "voice-file-id-123",
        mimeType: "audio/ogg",
        fileSize: 12345,
      },
    ]);
  });

  it("voice message from non-private chat is rejected", () => {
    const result = normalizeTelegramUpdate(
      makeVoicePayload({ chatType: "group" }),
    );
    expect(result).toBeNull();
  });

  it("voice message with missing sender is rejected", () => {
    const result = normalizeTelegramUpdate(makeVoicePayload({ fromId: null }));
    expect(result).toBeNull();
  });
});

describe("normalizeTelegramUpdate — audio messages", () => {
  it("audio message with caption produces audio attachment and caption as content", () => {
    const result = normalizeTelegramUpdate(
      makeAudioPayload({ caption: "Check out this song" }),
    );
    expect(result).not.toBeNull();
    expect(result!.message.content).toBe("Check out this song");
    expect(result!.message.attachments).toEqual([
      {
        type: "audio",
        fileId: "audio-file-id-456",
        fileName: "song.mp3",
        mimeType: "audio/mpeg",
        fileSize: 5000000,
      },
    ]);
  });

  it("audio message without caption has empty content", () => {
    const result = normalizeTelegramUpdate(makeAudioPayload());
    expect(result).not.toBeNull();
    expect(result!.message.content).toBe("");
    expect(result!.message.attachments).toHaveLength(1);
    expect(result!.message.attachments![0].type).toBe("audio");
  });

  it("audio message from non-private chat is rejected", () => {
    const result = normalizeTelegramUpdate(
      makeAudioPayload({ chatType: "supergroup" }),
    );
    expect(result).toBeNull();
  });

  it("audio message with missing sender is rejected", () => {
    const result = normalizeTelegramUpdate(makeAudioPayload({ fromId: null }));
    expect(result).toBeNull();
  });
});

describe("normalizeTelegramUpdate — malformed input is validated, not trusted", () => {
  it("drops a message whose chat.id is not a number", () => {
    // Before validation the blanket cast trusted this and forwarded
    // `String({...})` = "[object Object]" as the conversation id.
    const result = normalizeTelegramUpdate({
      update_id: 600,
      message: {
        message_id: 60,
        text: "hi",
        chat: { id: { nested: true }, type: "private" },
        from: { id: 42, first_name: "Alice" },
      },
    });
    expect(result).toBeNull();
  });

  it("ignores a non-array photo instead of treating it like an array", () => {
    // Before, `photo.length` on a non-array string produced a garbage
    // single-character attachment with an undefined fileId.
    const result = normalizeTelegramUpdate({
      update_id: 601,
      message: {
        message_id: 61,
        text: "caption text",
        photo: "not-an-array",
        chat: { id: 42, type: "private" },
        from: { id: 42, first_name: "Alice" },
      },
    });
    expect(result).not.toBeNull();
    expect(result!.message.content).toBe("caption text");
    expect(result!.message.attachments).toBeUndefined();
  });

  it("drops a non-numeric message_thread_id rather than stringifying it", () => {
    const result = normalizeTelegramUpdate({
      update_id: 602,
      message: {
        message_id: 62,
        message_thread_id: { bad: true },
        text: "hi",
        chat: { id: 42, type: "private" },
        from: { id: 42, first_name: "Alice" },
      },
    });
    expect(result).not.toBeNull();
    expect(result!.source.threadId).toBeUndefined();
  });

  it("preserves the original payload verbatim as `raw`, unknown keys included", () => {
    const payload = {
      update_id: 603,
      message: {
        message_id: 63,
        text: "hi",
        chat: { id: 42, type: "private" },
        from: { id: 42, first_name: "Alice" },
      },
      // The schema strips this from the parsed working copy; `raw` must keep it.
      unknown_future_field: { anything: 1 },
    };
    const result = normalizeTelegramUpdate(payload);
    expect(result).not.toBeNull();
    expect(result!.raw).toEqual(payload);
  });
});
