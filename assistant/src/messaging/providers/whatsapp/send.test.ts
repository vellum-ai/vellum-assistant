import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { ApprovalUIMetadata } from "@vellumai/gateway-client";

import type { CallbackContext } from "../channel-transport.js";

// The Cloud API answers every accepted send with the id it assigned. The stubs
// hand back a fresh id per call so the tests can tell which post each id
// belongs to; a stub returning no id stands in for an unexpected response.
let nextId = 1;
let respondWithoutIds = false;
const sent: Array<{ kind: "text" | "interactive"; body: string }> = [];

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
  sendWhatsAppMediaMessage: async () => apiResult(),
  uploadWhatsAppMedia: async () => ({ id: "media-1" }),
}));

mock.module("../../../persistence/attachments-store.js", () => ({
  getAttachmentContent: async () => null,
}));

mock.module("../../../util/logger.js", () => ({
  getLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
}));

const { sendWhatsAppReply } = await import("./send.js");
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
});

describe("sendWhatsAppReply acknowledged ids", () => {
  test("a short text is one post with one id", async () => {
    const result = await sendWhatsAppReply("12125550100", "hello");

    expect(sent).toHaveLength(1);
    expect(result).toEqual({ messageIds: ["wamid.1"] });
  });

  test("a split text acknowledges every chunk in send order", async () => {
    const result = await sendWhatsAppReply("12125550100", "x".repeat(9000));

    expect(sent).toHaveLength(3);
    expect(result).toEqual({ messageIds: ["wamid.1", "wamid.2", "wamid.3"] });
  });

  test("an approval that fits one interactive message is one id", async () => {
    const result = await sendWhatsAppReply("12125550100", "Approve?", approval);

    expect(sent.map((s) => s.kind)).toEqual(["interactive"]);
    expect(result).toEqual({ messageIds: ["wamid.1"] });
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
    expect(result).toEqual({ messageIds: ["wamid.1", "wamid.2", "wamid.3"] });
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
