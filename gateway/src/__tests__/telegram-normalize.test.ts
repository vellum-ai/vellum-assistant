import { describe, test, expect } from "bun:test";
import { normalizeTelegramUpdate } from "../telegram/normalize.js";
import { verifyWebhookSecret } from "../telegram/verify.js";

describe("normalizeTelegramUpdate", () => {
  const validPayload = {
    update_id: 123456,
    message: {
      message_id: 42,
      text: "Hello bot",
      chat: { id: 99001, type: "private" },
      from: {
        id: 55001,
        is_bot: false,
        username: "testuser",
        first_name: "Test",
        last_name: "User",
        language_code: "en",
      },
    },
  };

  test("normalizes a valid private text message", () => {
    const result = normalizeTelegramUpdate(validPayload);
    expect(result).not.toBeNull();
    expect(result!.version).toBe("v1");
    expect(result!.sourceChannel).toBe("telegram");
    expect(result!.message.content).toBe("Hello bot");
    expect(result!.message.externalChatId).toBe("99001");
    expect(result!.message.externalMessageId).toBe("123456");
    expect(result!.sender.externalUserId).toBe("55001");
    expect(result!.sender.username).toBe("testuser");
    expect(result!.sender.displayName).toBe("Test User");
    expect(result!.sender.firstName).toBe("Test");
    expect(result!.sender.lastName).toBe("User");
    expect(result!.sender.languageCode).toBe("en");
    expect(result!.sender.isBot).toBe(false);
    expect(result!.source.updateId).toBe("123456");
    expect(result!.source.messageId).toBe("42");
    expect(result!.source.chatType).toBe("private");
    expect(result!.raw).toEqual(validPayload);
  });

  test("returns null for unsupported message types (e.g. sticker-only)", () => {
    const payload = {
      update_id: 1,
      message: {
        message_id: 1,
        chat: { id: 1, type: "private" },
        sticker: { file_id: "abc" },
      },
    };
    expect(normalizeTelegramUpdate(payload)).toBeNull();
  });

  test("normalizes a photo message", () => {
    const payload = {
      update_id: 100,
      message: {
        message_id: 10,
        chat: { id: 200, type: "private" },
        from: { id: 300, is_bot: false, username: "photouser", first_name: "Photo" },
        photo: [
          { file_id: "small_id", file_unique_id: "s1", width: 90, height: 90 },
          { file_id: "medium_id", file_unique_id: "s2", width: 320, height: 320 },
          { file_id: "large_id", file_unique_id: "s3", width: 800, height: 800 },
        ],
        caption: "Check this out",
      },
    };
    const result = normalizeTelegramUpdate(payload);
    expect(result).not.toBeNull();
    expect(result!.message.content).toBe("Check this out");
    expect(result!.message.attachments).toHaveLength(1);
    expect(result!.message.attachments![0]).toEqual({
      type: "photo",
      fileId: "large_id",
      fileSize: undefined,
    });
  });

  test("normalizes a photo message without caption", () => {
    const payload = {
      update_id: 101,
      message: {
        message_id: 11,
        chat: { id: 200, type: "private" },
        from: { id: 300, is_bot: false },
        photo: [
          { file_id: "only_id", file_unique_id: "s1", width: 800, height: 800 },
        ],
      },
    };
    const result = normalizeTelegramUpdate(payload);
    expect(result).not.toBeNull();
    expect(result!.message.content).toBe("");
    expect(result!.message.attachments).toHaveLength(1);
    expect(result!.message.attachments![0].fileId).toBe("only_id");
  });

  test("normalizes a document message", () => {
    const payload = {
      update_id: 102,
      message: {
        message_id: 12,
        chat: { id: 200, type: "private" },
        from: { id: 300, is_bot: false, username: "docuser" },
        document: {
          file_id: "doc_file_id",
          file_unique_id: "du1",
          file_name: "report.pdf",
          mime_type: "application/pdf",
          file_size: 12345,
        },
        caption: "Here is the report",
      },
    };
    const result = normalizeTelegramUpdate(payload);
    expect(result).not.toBeNull();
    expect(result!.message.content).toBe("Here is the report");
    expect(result!.message.attachments).toHaveLength(1);
    expect(result!.message.attachments![0]).toEqual({
      type: "document",
      fileId: "doc_file_id",
      fileName: "report.pdf",
      mimeType: "application/pdf",
      fileSize: 12345,
    });
  });

  test("normalizes a document message without caption", () => {
    const payload = {
      update_id: 103,
      message: {
        message_id: 13,
        chat: { id: 200, type: "private" },
        from: { id: 300, is_bot: false },
        document: {
          file_id: "doc_id_2",
          file_unique_id: "du2",
          file_name: "data.csv",
          mime_type: "text/csv",
        },
      },
    };
    const result = normalizeTelegramUpdate(payload);
    expect(result).not.toBeNull();
    expect(result!.message.content).toBe("");
    expect(result!.message.attachments).toHaveLength(1);
  });

  test("text-only messages have no attachments field", () => {
    const result = normalizeTelegramUpdate(validPayload);
    expect(result).not.toBeNull();
    expect(result!.message.attachments).toBeUndefined();
  });

  test("returns null for group messages", () => {
    const payload = {
      ...validPayload,
      message: { ...validPayload.message, chat: { id: 99001, type: "group" } },
    };
    expect(normalizeTelegramUpdate(payload)).toBeNull();
  });

  test("returns null for payloads without update_id", () => {
    const { update_id: _, ...rest } = validPayload;
    expect(normalizeTelegramUpdate(rest)).toBeNull();
  });

  test("returns null for payloads without chat id", () => {
    const payload = {
      update_id: 1,
      message: { message_id: 1, text: "hello", chat: {} },
    };
    expect(normalizeTelegramUpdate(payload)).toBeNull();
  });

  test("uses chat.id as fallback for sender when from.id is missing", () => {
    const payload = {
      update_id: 1,
      message: {
        message_id: 1,
        text: "hello",
        chat: { id: 12345, type: "private" },
      },
    };
    const result = normalizeTelegramUpdate(payload);
    expect(result).not.toBeNull();
    expect(result!.sender.externalUserId).toBe("12345");
  });

  test("returns null for callback_query without message context", () => {
    const payload = {
      update_id: 1,
      callback_query: { id: "abc", from: { id: 123 }, data: "some_data" },
    };
    expect(normalizeTelegramUpdate(payload)).toBeNull();
  });

  test("normalizes an edited_message update with isEdit flag", () => {
    const payload = {
      update_id: 200,
      edited_message: {
        message_id: 42,
        text: "Hello bot (edited)",
        chat: { id: 99001, type: "private" },
        from: {
          id: 55001,
          is_bot: false,
          username: "testuser",
          first_name: "Test",
        },
      },
    };
    const result = normalizeTelegramUpdate(payload);
    expect(result).not.toBeNull();
    expect(result!.message.isEdit).toBe(true);
    expect(result!.message.content).toBe("Hello bot (edited)");
    expect(result!.message.externalChatId).toBe("99001");
    expect(result!.message.externalMessageId).toBe("200");
    expect(result!.source.updateId).toBe("200");
    expect(result!.source.messageId).toBe("42");
    expect(result!.sender.externalUserId).toBe("55001");
  });

  test("prefers message over edited_message when both are present", () => {
    const payload = {
      update_id: 300,
      message: {
        message_id: 50,
        text: "Original",
        chat: { id: 99001, type: "private" },
        from: { id: 55001, is_bot: false },
      },
      edited_message: {
        message_id: 50,
        text: "Edited",
        chat: { id: 99001, type: "private" },
        from: { id: 55001, is_bot: false },
      },
    };
    const result = normalizeTelegramUpdate(payload);
    expect(result).not.toBeNull();
    expect(result!.message.isEdit).toBeUndefined();
    expect(result!.message.content).toBe("Original");
  });

  test("sets isEdit for edited_message with photo", () => {
    const payload = {
      update_id: 400,
      edited_message: {
        message_id: 60,
        chat: { id: 200, type: "private" },
        from: { id: 300, is_bot: false },
        photo: [
          { file_id: "edited_photo", file_unique_id: "ep1", width: 800, height: 800 },
        ],
        caption: "Updated caption",
      },
    };
    const result = normalizeTelegramUpdate(payload);
    expect(result).not.toBeNull();
    expect(result!.message.isEdit).toBe(true);
    expect(result!.message.content).toBe("Updated caption");
    expect(result!.message.attachments).toHaveLength(1);
  });

  test("returns null for edited_message in group chat", () => {
    const payload = {
      update_id: 500,
      edited_message: {
        message_id: 70,
        text: "Edited group msg",
        chat: { id: 99001, type: "group" },
        from: { id: 55001, is_bot: false },
      },
    };
    expect(normalizeTelegramUpdate(payload)).toBeNull();
  });
});

describe("normalizeTelegramUpdate: callback_query", () => {
  test("normalizes a callback_query update with message context", () => {
    const payload = {
      update_id: 5001,
      callback_query: {
        id: "cbq-123",
        from: {
          id: 67890,
          is_bot: false,
          username: "testuser",
          first_name: "Test",
          last_name: "User",
          language_code: "en",
        },
        message: {
          message_id: 42,
          text: "Original message",
          chat: { id: 12345, type: "private" },
        },
        data: "apr:run-abc:approve",
      },
    };

    const result = normalizeTelegramUpdate(payload);

    expect(result).not.toBeNull();
    expect(result!.version).toBe("v1");
    expect(result!.sourceChannel).toBe("telegram");
    expect(result!.message.content).toBe("apr:run-abc:approve");
    expect(result!.message.externalChatId).toBe("12345");
    expect(result!.message.externalMessageId).toBe("5001");
    expect(result!.message.callbackQueryId).toBe("cbq-123");
    expect(result!.message.callbackData).toBe("apr:run-abc:approve");
    expect(result!.message.attachments).toBeUndefined();
    expect(result!.sender.externalUserId).toBe("67890");
    expect(result!.sender.username).toBe("testuser");
    expect(result!.sender.displayName).toBe("Test User");
    expect(result!.sender.firstName).toBe("Test");
    expect(result!.sender.lastName).toBe("User");
    expect(result!.sender.languageCode).toBe("en");
    expect(result!.sender.isBot).toBe(false);
    expect(result!.source.updateId).toBe("5001");
    expect(result!.source.messageId).toBe("42");
    expect(result!.source.chatType).toBe("private");
  });

  test("returns null when callback_query has no message (inline mode edge case)", () => {
    const payload = {
      update_id: 5002,
      callback_query: {
        id: "cbq-456",
        from: { id: 67890, is_bot: false, username: "testuser", first_name: "Test" },
        data: "some-data",
      },
    };

    const result = normalizeTelegramUpdate(payload);
    expect(result).toBeNull();
  });

  test("returns null when callback_query has no data", () => {
    const payload = {
      update_id: 5003,
      callback_query: {
        id: "cbq-789",
        from: { id: 67890, is_bot: false, username: "testuser", first_name: "Test" },
        message: {
          message_id: 42,
          text: "Original message",
          chat: { id: 12345, type: "private" },
        },
      },
    };

    const result = normalizeTelegramUpdate(payload);
    expect(result).toBeNull();
  });

  test("returns null when callback_query message has no chat id", () => {
    const payload = {
      update_id: 5004,
      callback_query: {
        id: "cbq-no-chat",
        from: { id: 67890, is_bot: false, username: "testuser", first_name: "Test" },
        message: {
          message_id: 42,
          text: "Original message",
          chat: {},
        },
        data: "some-data",
      },
    };

    const result = normalizeTelegramUpdate(payload);
    expect(result).toBeNull();
  });

  test("falls back to chat.id for externalUserId when from.id is missing", () => {
    const payload = {
      update_id: 5005,
      callback_query: {
        id: "cbq-no-from-id",
        from: { is_bot: false, username: "testuser", first_name: "Test" },
        message: {
          message_id: 42,
          text: "Original message",
          chat: { id: 12345, type: "private" },
        },
        data: "some-data",
      },
    };

    const result = normalizeTelegramUpdate(payload);
    expect(result).not.toBeNull();
    expect(result!.sender.externalUserId).toBe("12345");
  });

  test("callback_query does not set isEdit or attachments", () => {
    const payload = {
      update_id: 5006,
      callback_query: {
        id: "cbq-clean",
        from: { id: 67890, is_bot: false, username: "testuser", first_name: "Test" },
        message: {
          message_id: 42,
          text: "Original message",
          chat: { id: 12345, type: "private" },
        },
        data: "apr:run-xyz:reject",
      },
    };

    const result = normalizeTelegramUpdate(payload);
    expect(result).not.toBeNull();
    expect(result!.message.isEdit).toBeUndefined();
    expect(result!.message.attachments).toBeUndefined();
  });

  test("regular text messages are unaffected by callback_query support", () => {
    const payload = {
      update_id: 6001,
      message: {
        message_id: 100,
        text: "Hello world",
        chat: { id: 12345, type: "private" },
        from: { id: 67890, is_bot: false, username: "testuser", first_name: "Test" },
      },
    };

    const result = normalizeTelegramUpdate(payload);
    expect(result).not.toBeNull();
    expect(result!.message.content).toBe("Hello world");
    expect(result!.message.callbackQueryId).toBeUndefined();
    expect(result!.message.callbackData).toBeUndefined();
  });
});

describe("verifyWebhookSecret", () => {
  test("returns true for matching secret", () => {
    const headers = new Headers({ "x-telegram-bot-api-secret-token": "my-secret" });
    expect(verifyWebhookSecret(headers, "my-secret")).toBe(true);
  });

  test("returns false for mismatched secret", () => {
    const headers = new Headers({ "x-telegram-bot-api-secret-token": "wrong" });
    expect(verifyWebhookSecret(headers, "my-secret")).toBe(false);
  });

  test("returns false when header is missing", () => {
    const headers = new Headers();
    expect(verifyWebhookSecret(headers, "my-secret")).toBe(false);
  });

  test("returns false when expected secret is empty", () => {
    const headers = new Headers({ "x-telegram-bot-api-secret-token": "something" });
    expect(verifyWebhookSecret(headers, "")).toBe(false);
  });
});
