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
