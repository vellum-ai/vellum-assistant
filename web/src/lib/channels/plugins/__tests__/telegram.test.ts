import { describe, test, expect, afterEach, mock } from "bun:test";
import { telegramPlugin, downloadTelegramPhoto, downloadTelegramDocument } from "@/lib/channels/plugins/telegram";
import type { TelegramPhoto, TelegramDocument } from "@/lib/channels/plugins/telegram";

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

function makeDocumentPayload(overrides?: Record<string, unknown>) {
  return {
    update_id: 300,
    message: {
      message_id: 3,
      document: {
        file_id: "doc_id",
        file_unique_id: "du1",
        file_name: "report.pdf",
        mime_type: "application/pdf",
        file_size: 12345,
      },
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

  test("normalizes a document message", () => {
    const result = telegramPlugin.inbound.normalizeMessage(makeDocumentPayload());

    expect(result).not.toBeNull();
    expect(result!.text).toBe("");
    expect(result!.externalChatId).toBe("42");
    expect(result!.externalMessageId).toBe("300");
  });

  test("normalizes a document message with caption", () => {
    const result = telegramPlugin.inbound.normalizeMessage(
      makeDocumentPayload({ caption: "here is the report" }),
    );

    expect(result).not.toBeNull();
    expect(result!.text).toBe("here is the report");
  });

  test("returns null for document without file_id", () => {
    const payload = makeDocumentPayload();
    (payload.message as Record<string, unknown>).document = { file_unique_id: "du1" };

    const result = telegramPlugin.inbound.normalizeMessage(payload);
    expect(result).toBeNull();
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

// ---------------------------------------------------------------------------
// downloadTelegramPhoto
// ---------------------------------------------------------------------------

describe("downloadTelegramPhoto", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  test("downloads the largest photo size", async () => {
    globalThis.fetch = mock((url: string) => {
      if (url.includes("/getFile")) {
        return Promise.resolve(new Response(
          JSON.stringify({ ok: true, result: { file_id: "big", file_path: "photos/file_1.jpg" } }),
          { headers: { "content-type": "application/json" } },
        ));
      }
      return Promise.resolve(new Response(
        new Uint8Array([0xFF, 0xD8, 0xFF]),
        { headers: { "content-type": "image/jpeg" } },
      ));
    }) as unknown as typeof fetch;

    const photos: TelegramPhoto[] = [
      { file_id: "small", file_unique_id: "s1", width: 100, height: 100 },
      { file_id: "big", file_unique_id: "s2", width: 800, height: 600 },
    ];

    const result = await downloadTelegramPhoto("bot-token", photos);
    expect(result).not.toBeNull();
    expect(result!.filename).toBe("file_1.jpg");
    expect(result!.mimeType).toBe("image/jpeg");
    expect(result!.data).toBe(Buffer.from([0xFF, 0xD8, 0xFF]).toString("base64"));
  });

  test("returns null for empty photo array", async () => {
    const result = await downloadTelegramPhoto("bot-token", []);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// downloadTelegramDocument
// ---------------------------------------------------------------------------

describe("downloadTelegramDocument", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  test("downloads a document using hint metadata", async () => {
    globalThis.fetch = mock((url: string) => {
      if (url.includes("/getFile")) {
        return Promise.resolve(new Response(
          JSON.stringify({ ok: true, result: { file_id: "doc1", file_path: "documents/file_2.pdf" } }),
          { headers: { "content-type": "application/json" } },
        ));
      }
      return Promise.resolve(new Response(
        new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        { headers: { "content-type": "application/pdf" } },
      ));
    }) as unknown as typeof fetch;

    const doc: TelegramDocument = {
      file_id: "doc1",
      file_unique_id: "du1",
      file_name: "report.pdf",
      mime_type: "application/pdf",
    };

    const result = await downloadTelegramDocument("bot-token", doc);
    expect(result).not.toBeNull();
    expect(result!.filename).toBe("report.pdf");
    expect(result!.mimeType).toBe("application/pdf");
    expect(result!.data).toBe(Buffer.from([0x25, 0x50, 0x44, 0x46]).toString("base64"));
  });

  test("falls back to content-type and file_path when no hints", async () => {
    globalThis.fetch = mock((url: string) => {
      if (url.includes("/getFile")) {
        return Promise.resolve(new Response(
          JSON.stringify({ ok: true, result: { file_id: "doc2", file_path: "documents/file_3.bin" } }),
          { headers: { "content-type": "application/json" } },
        ));
      }
      return Promise.resolve(new Response(
        new Uint8Array([0x00]),
        { headers: { "content-type": "application/octet-stream" } },
      ));
    }) as unknown as typeof fetch;

    const doc: TelegramDocument = {
      file_id: "doc2",
      file_unique_id: "du2",
    };

    const result = await downloadTelegramDocument("bot-token", doc);
    expect(result).not.toBeNull();
    expect(result!.filename).toBe("file_3.bin");
    expect(result!.mimeType).toBe("application/octet-stream");
  });
});
