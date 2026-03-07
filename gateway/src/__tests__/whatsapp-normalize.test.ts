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
});
