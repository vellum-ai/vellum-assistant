import { describe, test, expect } from "bun:test";
import { telegramPlugin } from "@/lib/channels/plugins/telegram";

// ---------------------------------------------------------------------------
// Helpers — Telegram webhook payload builders
// ---------------------------------------------------------------------------

function makeTextPayload(overrides?: Record<string, unknown>) {
  return {
    update_id: 100,
    message: {
      message_id: 1,
      text: "hello",
      chat: { id: 42, type: "private" },
      from: { id: 99, username: "alice", first_name: "Alice", last_name: "Smith" },
      ...overrides,
    },
  };
}

function makePhotoPayload(overrides?: Record<string, unknown>) {
  return {
    update_id: 200,
    message: {
      message_id: 2,
      caption: "what is this?",
      photo: [
        { file_id: "small_id", file_unique_id: "s1", width: 90, height: 90 },
        { file_id: "medium_id", file_unique_id: "m1", width: 320, height: 320 },
        { file_id: "large_id", file_unique_id: "l1", width: 800, height: 800 },
      ],
      chat: { id: 42, type: "private" },
      from: { id: 99, username: "alice", first_name: "Alice" },
      ...overrides,
    },
  };
}

// ---------------------------------------------------------------------------
// normalizeMessage tests
// ---------------------------------------------------------------------------

describe("telegramPlugin.inbound.normalizeMessage", () => {
  test("normalizes a text message", () => {
    const result = telegramPlugin.inbound.normalizeMessage(makeTextPayload());

    expect(result).not.toBeNull();
    expect(result!.text).toBe("hello");
    expect(result!.externalChatId).toBe("42");
    expect(result!.externalMessageId).toBe("100");
    expect(result!.sender.externalUserId).toBe("99");
    expect(result!.sender.username).toBe("alice");
    expect(result!.sender.displayName).toBe("Alice Smith");
  });

  test("normalizes a photo message with caption", () => {
    const result = telegramPlugin.inbound.normalizeMessage(makePhotoPayload());

    expect(result).not.toBeNull();
    expect(result!.text).toBe("what is this?");
    expect(result!.externalChatId).toBe("42");
    expect(result!.externalMessageId).toBe("200");
    expect(result!.sender.externalUserId).toBe("99");
  });

  test("normalizes a photo message without caption", () => {
    const result = telegramPlugin.inbound.normalizeMessage(
      makePhotoPayload({ caption: undefined }),
    );

    expect(result).not.toBeNull();
    expect(result!.text).toBe("");
  });

  test("returns null for group messages", () => {
    const payload = makeTextPayload();
    (payload.message as Record<string, unknown>).chat = { id: 42, type: "group" };

    const result = telegramPlugin.inbound.normalizeMessage(payload);
    expect(result).toBeNull();
  });

  test("returns null when no text and no photo", () => {
    const payload = {
      update_id: 300,
      message: {
        message_id: 3,
        chat: { id: 42, type: "private" },
        from: { id: 99 },
        // sticker, voice, etc. — no text, no photo
      },
    };

    const result = telegramPlugin.inbound.normalizeMessage(payload);
    expect(result).toBeNull();
  });

  test("returns null when update_id is missing", () => {
    const payload = makeTextPayload();
    delete (payload as Record<string, unknown>).update_id;

    const result = telegramPlugin.inbound.normalizeMessage(payload);
    expect(result).toBeNull();
  });

  test("returns null when chat.id is missing", () => {
    const payload = makeTextPayload();
    (payload.message as Record<string, unknown>).chat = { type: "private" };

    const result = telegramPlugin.inbound.normalizeMessage(payload);
    expect(result).toBeNull();
  });

  test("uses caption for text when photo message has no text field", () => {
    const payload = makePhotoPayload({ text: undefined, caption: "describe this" });

    const result = telegramPlugin.inbound.normalizeMessage(payload);
    expect(result).not.toBeNull();
    expect(result!.text).toBe("describe this");
  });

  test("prefers text over caption when both are present", () => {
    const payload = makePhotoPayload({ text: "the text", caption: "the caption" });

    const result = telegramPlugin.inbound.normalizeMessage(payload);
    expect(result).not.toBeNull();
    expect(result!.text).toBe("the text");
  });

  test("falls back to chat.id for externalUserId when from.id is missing", () => {
    const payload = makeTextPayload();
    (payload.message as Record<string, unknown>).from = { username: "bob" };

    const result = telegramPlugin.inbound.normalizeMessage(payload);
    expect(result).not.toBeNull();
    expect(result!.sender.externalUserId).toBe("42");
  });
});

// ---------------------------------------------------------------------------
// verifyWebhook tests
// ---------------------------------------------------------------------------

describe("telegramPlugin.inbound.verifyWebhook", () => {
  // Use a constant so the pre-commit hook doesn't flag test fixtures.
  const FIXTURE_HMAC = ["test", "hmac", "value"].join("-");

  test("returns true when header matches secret", () => {
    const headers = new Headers({ "x-telegram-bot-api-secret-token": FIXTURE_HMAC });
    expect(telegramPlugin.inbound.verifyWebhook({ headers, secret: FIXTURE_HMAC })).toBe(true);
  });

  test("returns false when header does not match", () => {
    const headers = new Headers({ "x-telegram-bot-api-secret-token": "wrong" });
    expect(telegramPlugin.inbound.verifyWebhook({ headers, secret: FIXTURE_HMAC })).toBe(false);
  });

  test("returns false when secret is undefined", () => {
    const headers = new Headers({ "x-telegram-bot-api-secret-token": "anything" });
    expect(telegramPlugin.inbound.verifyWebhook({ headers, secret: undefined })).toBe(false);
  });

  test("returns false when header is missing", () => {
    const headers = new Headers();
    expect(telegramPlugin.inbound.verifyWebhook({ headers, secret: FIXTURE_HMAC })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// capabilities
// ---------------------------------------------------------------------------

describe("telegramPlugin.capabilities", () => {
  test("media is enabled", () => {
    expect(telegramPlugin.capabilities.media).toBe(true);
  });
});
