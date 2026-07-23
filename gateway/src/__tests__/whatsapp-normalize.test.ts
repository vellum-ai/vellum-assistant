import { describe, test, expect } from "bun:test";
import { normalizeWhatsAppWebhook } from "../whatsapp/normalize.js";

function makeWhatsAppPayload(
  message: Record<string, unknown>,
  contact?: { profile?: { name?: string }; wa_id?: string },
) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "BIZ_ACCOUNT_ID",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                phone_number_id: "PHONE_ID",
                display_phone_number: "+1234567890",
              },
              contacts: contact
                ? [contact]
                : [{ profile: { name: "Test User" }, wa_id: "15551234567" }],
              messages: [message],
            },
          },
        ],
      },
    ],
  };
}

// Reserved-range fictional sender (AGENTS.md § Generic Examples, 555-01xx) and
// a fixture unix-seconds timestamp, shared by the validation tests below.
const WA_FROM = "12025550142";
// generic-examples:ignore-next-line — reason: unix-seconds fixture timestamp, not a phone number
const WA_TS = "1700000000";

describe("normalizeWhatsAppWebhook", () => {
  describe("image messages", () => {
    test("image with caption preserves both content and attachment", () => {
      const payload = makeWhatsAppPayload({
        id: "wamid.img1",
        from: "15551234567",
        timestamp: "1700000000",
        type: "image",
        image: {
          id: "media_id_123",
          mime_type: "image/jpeg",
          caption: "Check this out",
          file_size: 204800,
        },
      });

      const results = normalizeWhatsAppWebhook(payload);
      expect(results).toHaveLength(1);

      const { event, mediaType } = results[0];
      expect(mediaType).toBe("image");
      expect(event.message.content).toBe("Check this out");
      expect(event.message.attachments).toHaveLength(1);
      expect(event.message.attachments![0]).toEqual({
        type: "image",
        fileId: "media_id_123",
        mimeType: "image/jpeg",
        fileSize: 204800,
      });
    });

    test("image without caption produces empty content but has attachment", () => {
      const payload = makeWhatsAppPayload({
        id: "wamid.img2",
        from: "15551234567",
        timestamp: "1700000000",
        type: "image",
        image: {
          id: "media_id_456",
          mime_type: "image/png",
          file_size: 102400,
        },
      });

      const results = normalizeWhatsAppWebhook(payload);
      expect(results).toHaveLength(1);

      const { event } = results[0];
      expect(event.message.content).toBe("");
      expect(event.message.attachments).toHaveLength(1);
      expect(event.message.attachments![0]).toEqual({
        type: "image",
        fileId: "media_id_456",
        mimeType: "image/png",
        fileSize: 102400,
      });
    });
  });

  describe("video messages", () => {
    test("video with caption preserves both content and attachment", () => {
      const payload = makeWhatsAppPayload({
        id: "wamid.vid1",
        from: "15551234567",
        timestamp: "1700000000",
        type: "video",
        video: {
          id: "media_id_vid",
          mime_type: "video/mp4",
          caption: "Watch this",
          file_size: 5242880,
        },
      });

      const results = normalizeWhatsAppWebhook(payload);
      expect(results).toHaveLength(1);

      const { event, mediaType } = results[0];
      expect(mediaType).toBe("video");
      expect(event.message.content).toBe("Watch this");
      expect(event.message.attachments).toHaveLength(1);
      expect(event.message.attachments![0]).toEqual({
        type: "video",
        fileId: "media_id_vid",
        mimeType: "video/mp4",
        fileSize: 5242880,
      });
    });
  });

  describe("audio messages", () => {
    test("audio message produces attachment with no content", () => {
      const payload = makeWhatsAppPayload({
        id: "wamid.aud1",
        from: "15551234567",
        timestamp: "1700000000",
        type: "audio",
        audio: {
          id: "media_id_aud",
          mime_type: "audio/ogg; codecs=opus",
          file_size: 65536,
        },
      });

      const results = normalizeWhatsAppWebhook(payload);
      expect(results).toHaveLength(1);

      const { event, mediaType } = results[0];
      expect(mediaType).toBe("audio");
      expect(event.message.content).toBe("");
      expect(event.message.attachments).toHaveLength(1);
      expect(event.message.attachments![0]).toEqual({
        type: "audio",
        fileId: "media_id_aud",
        mimeType: "audio/ogg; codecs=opus",
        fileSize: 65536,
      });
    });
  });

  describe("document messages", () => {
    test("document with caption and filename preserves all fields", () => {
      const payload = makeWhatsAppPayload({
        id: "wamid.doc1",
        from: "15551234567",
        timestamp: "1700000000",
        type: "document",
        document: {
          id: "media_id_doc",
          mime_type: "application/pdf",
          caption: "Here is the report",
          filename: "report.pdf",
          file_size: 1048576,
        },
      });

      const results = normalizeWhatsAppWebhook(payload);
      expect(results).toHaveLength(1);

      const { event, mediaType } = results[0];
      expect(mediaType).toBe("document");
      expect(event.message.content).toBe("Here is the report");
      expect(event.message.attachments).toHaveLength(1);
      expect(event.message.attachments![0]).toEqual({
        type: "document",
        fileId: "media_id_doc",
        mimeType: "application/pdf",
        fileName: "report.pdf",
        fileSize: 1048576,
      });
    });

    test("document without caption produces empty content", () => {
      const payload = makeWhatsAppPayload({
        id: "wamid.doc2",
        from: "15551234567",
        timestamp: "1700000000",
        type: "document",
        document: {
          id: "media_id_doc2",
          mime_type:
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          filename: "data.xlsx",
        },
      });

      const results = normalizeWhatsAppWebhook(payload);
      expect(results).toHaveLength(1);

      const { event } = results[0];
      expect(event.message.content).toBe("");
      expect(event.message.attachments).toHaveLength(1);
      expect(event.message.attachments![0]).toEqual({
        type: "document",
        fileId: "media_id_doc2",
        mimeType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        fileName: "data.xlsx",
      });
    });
  });

  describe("sticker messages", () => {
    test("sticker message produces attachment with no content", () => {
      const payload = makeWhatsAppPayload({
        id: "wamid.stk1",
        from: "15551234567",
        timestamp: "1700000000",
        type: "sticker",
        sticker: {
          id: "media_id_stk",
          mime_type: "image/webp",
        },
      });

      const results = normalizeWhatsAppWebhook(payload);
      expect(results).toHaveLength(1);

      const { event, mediaType } = results[0];
      expect(mediaType).toBe("sticker");
      expect(event.message.content).toBe("");
      expect(event.message.attachments).toHaveLength(1);
      expect(event.message.attachments![0]).toEqual({
        type: "sticker",
        fileId: "media_id_stk",
        mimeType: "image/webp",
      });
    });
  });

  describe("text messages", () => {
    test("text messages have no attachments", () => {
      const payload = makeWhatsAppPayload({
        id: "wamid.txt1",
        from: "15551234567",
        timestamp: "1700000000",
        type: "text",
        text: { body: "Hello there" },
      });

      const results = normalizeWhatsAppWebhook(payload);
      expect(results).toHaveLength(1);

      const { event, mediaType } = results[0];
      expect(mediaType).toBeUndefined();
      expect(event.message.content).toBe("Hello there");
      expect(event.message.attachments).toBeUndefined();
    });
  });

  describe("media without media ID", () => {
    test("image without media ID produces no attachments", () => {
      const payload = makeWhatsAppPayload({
        id: "wamid.noid",
        from: "15551234567",
        timestamp: "1700000000",
        type: "image",
        image: {
          mime_type: "image/jpeg",
          caption: "No ID here",
        },
      });

      const results = normalizeWhatsAppWebhook(payload);
      expect(results).toHaveLength(1);

      const { event } = results[0];
      expect(event.message.content).toBe("No ID here");
      expect(event.message.attachments).toBeUndefined();
    });
  });

  describe("optional fields", () => {
    test("omits fileName, mimeType, fileSize when not provided by Meta", () => {
      const payload = makeWhatsAppPayload({
        id: "wamid.minimal",
        from: "15551234567",
        timestamp: "1700000000",
        type: "audio",
        audio: {
          id: "media_id_minimal",
        },
      });

      const results = normalizeWhatsAppWebhook(payload);
      expect(results).toHaveLength(1);

      const attachment = results[0].event.message.attachments![0];
      expect(attachment).toEqual({
        type: "audio",
        fileId: "media_id_minimal",
      });
      expect(attachment).not.toHaveProperty("fileName");
      expect(attachment).not.toHaveProperty("mimeType");
      expect(attachment).not.toHaveProperty("fileSize");
    });
  });

  describe("interactive messages", () => {
    test("button_reply becomes callbackData with the title as content", () => {
      const payload = makeWhatsAppPayload({
        id: "wamid.int1",
        from: WA_FROM,
        timestamp: WA_TS,
        type: "interactive",
        interactive: {
          type: "button_reply",
          button_reply: { id: "apr:run1:approve", title: "Approve" },
        },
      });

      const results = normalizeWhatsAppWebhook(payload);
      expect(results).toHaveLength(1);
      expect(results[0].event.message.callbackData).toBe("apr:run1:approve");
      expect(results[0].event.message.content).toBe("Approve");
    });

    test("a non-button_reply interactive message is skipped", () => {
      const payload = makeWhatsAppPayload({
        id: "wamid.int2",
        from: WA_FROM,
        timestamp: WA_TS,
        type: "interactive",
        interactive: { type: "list_reply", list_reply: { id: "x" } },
      });
      expect(normalizeWhatsAppWebhook(payload)).toHaveLength(0);
    });
  });

  describe("provider timestamp is not consumed (receivedAt is the gateway's clock)", () => {
    // `receivedAt` is the gateway's wall-clock receipt time, like every other
    // channel — the sender-supplied `timestamp` never reaches a `Date`. So no
    // timestamp value (missing, non-numeric, or out of Date's range) can throw
    // or otherwise affect normalization; the message is processed normally.
    test.each([
      ["missing", undefined],
      ["non-numeric", "not-a-number"],
      ["out-of-range digits", "9999999999999"],
    ])("a %s timestamp is processed normally, never throwing", (_label, ts) => {
      const payload = makeWhatsAppPayload({
        id: "wamid.ts",
        from: WA_FROM,
        ...(ts === undefined ? {} : { timestamp: ts }),
        type: "text",
        text: { body: "hi" },
      });
      let results!: ReturnType<typeof normalizeWhatsAppWebhook>;
      expect(() => {
        results = normalizeWhatsAppWebhook(payload);
      }).not.toThrow();
      expect(results).toHaveLength(1);
      expect(results[0].event.message.content).toBe("hi");
    });

    test("receivedAt is a recent wall-clock time, not derived from the provider timestamp", () => {
      const before = Date.now();
      const payload = makeWhatsAppPayload({
        id: "wamid.recv",
        from: WA_FROM,
        // A historical send-time; receivedAt must NOT reflect it.
        timestamp: WA_TS,
        type: "text",
        text: { body: "hi" },
      });
      const results = normalizeWhatsAppWebhook(payload);
      const after = Date.now();
      expect(results).toHaveLength(1);
      const receivedMs = new Date(results[0].event.receivedAt).getTime();
      expect(receivedMs).toBeGreaterThanOrEqual(before);
      expect(receivedMs).toBeLessThanOrEqual(after);
    });
  });

  describe("malformed input is dropped, not trusted", () => {
    test("a message with a missing id is dropped", () => {
      const payload = makeWhatsAppPayload({
        from: WA_FROM,
        timestamp: WA_TS,
        type: "text",
        text: { body: "hi" },
      });
      expect(normalizeWhatsAppWebhook(payload)).toHaveLength(0);
    });

    test("a message with a missing sender is dropped", () => {
      const payload = makeWhatsAppPayload({
        id: "wamid.no-from",
        timestamp: WA_TS,
        type: "text",
        text: { body: "hi" },
      });
      expect(normalizeWhatsAppWebhook(payload)).toHaveLength(0);
    });

    test("valid messages in a batch survive when one message is malformed", () => {
      // The malformed message is first: a valid message after it in the same
      // batch must still be normalized (one bad message does not discard the
      // whole batch).
      const payload = {
        object: "whatsapp_business_account",
        entry: [
          {
            id: "BIZ",
            changes: [
              {
                field: "messages",
                value: {
                  messaging_product: "whatsapp",
                  contacts: [{ wa_id: WA_FROM, profile: { name: "A" } }],
                  messages: [
                    // malformed: no sender identity
                    {
                      id: "wamid.bad",
                      timestamp: WA_TS,
                      type: "text",
                      text: { body: "bad" },
                    },
                    {
                      id: "wamid.good",
                      from: WA_FROM,
                      timestamp: WA_TS,
                      type: "text",
                      text: { body: "survivor" },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };
      const results = normalizeWhatsAppWebhook(payload);
      expect(results).toHaveLength(1);
      expect(results[0].whatsappMessageId).toBe("wamid.good");
      expect(results[0].event.message.content).toBe("survivor");
    });

    test("a valid but unsupported message type (e.g. location) is skipped without throwing", () => {
      const payload = makeWhatsAppPayload({
        id: "wamid.loc",
        from: WA_FROM,
        timestamp: WA_TS,
        type: "location",
        location: { latitude: 1, longitude: 2 },
      });
      expect(() => normalizeWhatsAppWebhook(payload)).not.toThrow();
      expect(normalizeWhatsAppWebhook(payload)).toHaveLength(0);
    });

    test("a non-WhatsApp object returns []", () => {
      expect(normalizeWhatsAppWebhook({ object: "page", entry: [] })).toEqual(
        [],
      );
    });

    test("a structurally invalid payload returns [] rather than throwing", () => {
      expect(() =>
        normalizeWhatsAppWebhook({ entry: "not-an-array" }),
      ).not.toThrow();
      expect(normalizeWhatsAppWebhook({ entry: "not-an-array" })).toEqual([]);
    });
  });

  describe("serve boundary", () => {
    test("preserves the original payload verbatim as raw, unknown keys included", () => {
      const payload = makeWhatsAppPayload({
        id: "wamid.raw",
        from: WA_FROM,
        timestamp: WA_TS,
        type: "text",
        text: { body: "hi" },
      });
      // A field the schema strips from its working copy; raw must keep it.
      (payload as Record<string, unknown>).unknown_future_field = { any: 1 };

      const results = normalizeWhatsAppWebhook(payload);
      expect(results).toHaveLength(1);
      expect(results[0].event.raw).toEqual(payload);
      expect(
        (results[0].event.raw as Record<string, unknown>).unknown_future_field,
      ).toEqual({ any: 1 });
    });
  });
});
