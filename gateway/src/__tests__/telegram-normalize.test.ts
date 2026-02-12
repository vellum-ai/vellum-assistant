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

  test("returns null for non-text messages", () => {
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

  test("returns null for non-message updates (e.g. callback_query)", () => {
    const payload = {
      update_id: 1,
      callback_query: { id: "abc", data: "some_data" },
    };
    expect(normalizeTelegramUpdate(payload)).toBeNull();
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
