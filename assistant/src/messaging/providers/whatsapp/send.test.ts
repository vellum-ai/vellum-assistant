import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { ApprovalUIMetadata } from "@vellumai/gateway-client";

import type { RuntimeAttachmentMetadata } from "../../../runtime/http-types.js";
import type { CallbackContext } from "../channel-transport.js";

// The Cloud API answers every accepted send with the id it assigned. The stubs
// hand back a fresh id per call so the tests can tell which post each id
// belongs to; a stub returning no id stands in for an unexpected response.
let nextId = 1;
let respondWithoutIds = false;
const sent: Array<{ kind: "text" | "interactive"; body: string }> = [];
// Each media upload and each media message the attachment sender posted.
const uploads: Array<{ blob: Blob; filename: string; mimeType: string }> = [];
const mediaMessages: Array<{
  to: string;
  mediaType: string;
  mediaId: string;
  filename?: string;
}> = [];
// Filenames whose upload the stubbed Cloud API rejects.
const rejectUploadOf = new Set<string>();
// Bytes the stubbed attachment store holds, keyed by attachment id.
let storeContents: Record<string, Buffer> = {};
const storeReads: string[] = [];

function apiResult() {
  if (respondWithoutIds) {
    return { messaging_product: "whatsapp", contacts: [], messages: [] };
  }
  return {
    messaging_product: "whatsapp",
    contacts: [],
    messages: [{ id: `wamid.${nextId++}` }],
  };
}

mock.module("./api.js", () => ({
  sendWhatsAppTextMessage: async (_to: string, text: string) => {
    sent.push({ kind: "text", body: text });
    return apiResult();
  },
  sendWhatsAppInteractiveMessage: async (_to: string, body: string) => {
    sent.push({ kind: "interactive", body });
    return apiResult();
  },
  sendWhatsAppMediaMessage: async (
    to: string,
    mediaType: string,
    mediaId: string,
    filename?: string,
  ) => {
    mediaMessages.push({ to, mediaType, mediaId, filename });
    return apiResult();
  },
  uploadWhatsAppMedia: async (
    blob: Blob,
    filename: string,
    mimeType: string,
  ) => {
    uploads.push({ blob, filename, mimeType });
    if (rejectUploadOf.has(filename)) {
      throw new Error("WhatsApp API error (400): invalid media");
    }
    return { id: `media-${uploads.length}` };
  },
}));

mock.module("../../../persistence/attachments-store.js", () => ({
  getAttachmentContent: (attachmentId: string) => {
    storeReads.push(attachmentId);
    return storeContents[attachmentId] ?? null;
  },
}));

mock.module("../../../util/logger.js", () => ({
  getLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
}));

const { sendWhatsAppAttachments, sendWhatsAppReply } =
  await import("./send.js");
const { whatsappTransport } = await import("./transport.js");

const approval: ApprovalUIMetadata = {
  requestId: "req-1",
  plainTextFallback: "Approve?",
  actions: [
    { id: "approve", label: "Approve" },
    { id: "deny", label: "Deny" },
  ],
};

beforeEach(() => {
  nextId = 1;
  respondWithoutIds = false;
  sent.length = 0;
  uploads.length = 0;
  mediaMessages.length = 0;
  rejectUploadOf.clear();
  storeContents = {};
  storeReads.length = 0;
});

describe("sendWhatsAppReply acknowledged ids", () => {
  test("a short text is one post with one id", async () => {
    const result = await sendWhatsAppReply("12125550100", "hello");

    expect(sent).toHaveLength(1);
    expect(result).toEqual({
      lastMessageId: "wamid.1",
      messageIds: ["wamid.1"],
    });
  });

  test("a split text acknowledges every chunk in send order", async () => {
    const result = await sendWhatsAppReply("12125550100", "x".repeat(9000));

    expect(sent).toHaveLength(3);
    expect(result).toEqual({
      lastMessageId: "wamid.3",
      messageIds: ["wamid.1", "wamid.2", "wamid.3"],
    });
  });

  test("an approval that fits one interactive message is one id", async () => {
    const result = await sendWhatsAppReply("12125550100", "Approve?", approval);

    expect(sent.map((s) => s.kind)).toEqual(["interactive"]);
    expect(result).toEqual({
      lastMessageId: "wamid.1",
      messageIds: ["wamid.1"],
    });
  });

  test("a long approval acknowledges its text chunks and the button message", async () => {
    const result = await sendWhatsAppReply(
      "12125550100",
      "y".repeat(6096),
      approval,
    );

    // A 4096-char chunk, then a 2000-char last chunk that is over the
    // interactive body limit, so the buttons ride a third, separate message.
    expect(sent.map((s) => s.kind)).toEqual(["text", "text", "interactive"]);
    expect(result).toEqual({
      lastMessageId: "wamid.3",
      messageIds: ["wamid.1", "wamid.2", "wamid.3"],
    });
  });

  test("a response without an id acknowledges nothing rather than inventing one", async () => {
    respondWithoutIds = true;
    const result = await sendWhatsAppReply("12125550100", "hello");

    expect(result).toEqual({ messageIds: [] });
  });
});

describe("whatsappTransport.deliver", () => {
  const ctx: CallbackContext = { callbackUrl: "/deliver/whatsapp", params: {} };

  test("acknowledges every message the text became", async () => {
    const result = await whatsappTransport.deliver(ctx, {
      chatId: "12125550100",
      text: "x".repeat(5000),
    });

    expect(result).toEqual({ ok: true, messageIds: ["wamid.1", "wamid.2"] });
  });

  test("acknowledges nothing when there was no text", async () => {
    const result = await whatsappTransport.deliver(ctx, {
      chatId: "12125550100",
    });

    expect(sent).toHaveLength(0);
    expect(result).toEqual({ ok: true, messageIds: [] });
  });
});

describe("sendWhatsAppAttachments", () => {
  // The sender's own cap on an outbound attachment.
  const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
  const TO = "12125550100";

  function attachment(
    id: string,
    filename: string,
    mimeType: string,
    sizeBytes = 3,
  ): RuntimeAttachmentMetadata {
    return { id, filename, mimeType, sizeBytes, kind: "file" };
  }

  const notices = () =>
    sent.filter((s) => s.kind === "text").map((s) => s.body);

  test("uploads the stored bytes and posts them as the matching media type", async () => {
    storeContents = {
      "att-1": Buffer.from("jpg"),
      "att-2": Buffer.from("mp4"),
      "att-3": Buffer.from("pdf"),
    };

    const result = await sendWhatsAppAttachments(TO, [
      attachment("att-1", "photo.jpg", "image/jpeg"),
      attachment("att-2", "clip.mp4", "video/mp4"),
      attachment("att-3", "report.pdf", "application/pdf"),
    ]);

    expect(uploads.map((u) => [u.filename, u.mimeType, u.blob.type])).toEqual([
      ["photo.jpg", "image/jpeg", "image/jpeg"],
      ["clip.mp4", "video/mp4", "video/mp4"],
      ["report.pdf", "application/pdf", "application/pdf"],
    ]);
    expect(await uploads[0]?.blob.text()).toBe("jpg");
    // Each message references the id its own upload returned.
    expect(mediaMessages).toEqual([
      { to: TO, mediaType: "image", mediaId: "media-1", filename: "photo.jpg" },
      { to: TO, mediaType: "video", mediaId: "media-2", filename: "clip.mp4" },
      {
        to: TO,
        mediaType: "document",
        mediaId: "media-3",
        filename: "report.pdf",
      },
    ]);
    expect(notices()).toEqual([]);
    expect(result).toEqual({
      allFailed: false,
      failureCount: 0,
      totalCount: 3,
    });
  });

  test("skips an attachment whose declared size is over the cap without reading it", async () => {
    storeContents = { "att-1": Buffer.from("mp4") };

    const result = await sendWhatsAppAttachments(TO, [
      attachment("att-1", "huge.mp4", "video/mp4", MAX_ATTACHMENT_BYTES + 1),
    ]);

    expect(storeReads).toEqual([]);
    expect(uploads).toHaveLength(0);
    expect(notices()).toEqual([
      "1 attachment(s) could not be delivered: huge.mp4",
    ]);
    expect(result).toEqual({ allFailed: true, failureCount: 1, totalCount: 1 });
  });

  test("skips an attachment whose stored bytes are over the cap", async () => {
    // The declared size understates what the store actually holds.
    storeContents = { "att-1": Buffer.alloc(MAX_ATTACHMENT_BYTES + 1) };

    const result = await sendWhatsAppAttachments(TO, [
      attachment("att-1", "long.mp4", "video/mp4"),
    ]);

    expect(uploads).toHaveLength(0);
    expect(notices()).toEqual([
      "1 attachment(s) could not be delivered: long.mp4",
    ]);
    expect(result).toEqual({ allFailed: true, failureCount: 1, totalCount: 1 });
  });

  test("reports an attachment the store has no content for", async () => {
    const result = await sendWhatsAppAttachments(TO, [
      attachment("att-1", "missing.txt", "text/plain"),
    ]);

    expect(storeReads).toEqual(["att-1"]);
    expect(uploads).toHaveLength(0);
    expect(notices()).toEqual([
      "1 attachment(s) could not be delivered: missing.txt",
    ]);
    expect(result).toEqual({ allFailed: true, failureCount: 1, totalCount: 1 });
  });

  test("keeps sending after one upload fails and names only the failure", async () => {
    storeContents = {
      "att-1": Buffer.from("a"),
      "att-2": Buffer.from("b"),
      "att-3": Buffer.from("c"),
    };
    rejectUploadOf.add("b.txt");

    const result = await sendWhatsAppAttachments(TO, [
      attachment("att-1", "a.txt", "text/plain"),
      attachment("att-2", "b.txt", "text/plain"),
      attachment("att-3", "c.txt", "text/plain"),
    ]);

    expect(mediaMessages.map((m) => m.filename)).toEqual(["a.txt", "c.txt"]);
    expect(notices()).toEqual([
      "1 attachment(s) could not be delivered: b.txt",
    ]);
    expect(result).toEqual({
      allFailed: false,
      failureCount: 1,
      totalCount: 3,
    });
  });
});
