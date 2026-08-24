import { beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  ApprovalUIMetadata,
  ChannelReplyPayload,
} from "@vellumai/gateway-client";

import type { CallbackContext } from "../channel-transport.js";

// Derive the mock signature from the real export so the test cannot drift from
// the production call signature.
type CallTelegramBotApi = typeof import("./api.js").callTelegramBotApi;

const callTelegramBotApiMock = mock<CallTelegramBotApi>(
  async () => ({}) as never,
);

mock.module("./api.js", () => ({
  callTelegramBotApi: (method: string, body: Record<string, unknown>) =>
    callTelegramBotApiMock(method, body),
  callTelegramBotApiMultipart: async () => ({}),
  TelegramNonRetryableError: class TelegramNonRetryableError extends Error {
    readonly description: string | undefined;
    constructor(message: string, description?: string) {
      super(message);
      this.name = "TelegramNonRetryableError";
      this.description = description;
    }
  },
}));

const { TelegramNonRetryableError } = await import("./api.js");
const { editTelegramMessage, sendTelegramReply, sendTelegramRichReply } =
  await import("./send.js");
const { telegramTransport } = await import("./transport.js");

const approval: ApprovalUIMetadata = {
  requestId: "req-1",
  plainTextFallback: "Approve?",
  actions: [
    { id: "approve", label: "Approve" },
    { id: "deny", label: "Deny" },
  ],
};

const expectedKeyboard = {
  inline_keyboard: [
    [{ text: "Approve", callback_data: "apr:req-1:approve" }],
    [{ text: "Deny", callback_data: "apr:req-1:deny" }],
  ],
};

const callsTo = (method: string) =>
  callTelegramBotApiMock.mock.calls.filter((call) => call[0] === method);

beforeEach(() => {
  callTelegramBotApiMock.mockReset();
  callTelegramBotApiMock.mockImplementation(async () => ({}) as never);
});

describe("sendTelegramRichReply", () => {
  test("renders markdown to HTML and sends it via the nested rich_message object", async () => {
    await sendTelegramRichReply("123", "# Heading\n\n| a | b |\n| - | - |");

    expect(callsTo("sendRichMessage")).toHaveLength(1);
    expect(callsTo("sendMessage")).toHaveLength(0);
    expect(callTelegramBotApiMock).toHaveBeenCalledWith("sendRichMessage", {
      chat_id: "123",
      rich_message: {
        html: "<h1>Heading</h1><table><tr><th>a</th><th>b</th></tr></table>",
        skip_entity_detection: true,
      },
    });
  });

  test("escapes Telegram Rich-Markdown-only syntax so it renders as written", async () => {
    // `$…$` math, `==highlight==`, `||spoiler||`, and literal `<` are Telegram
    // Rich Markdown extensions; HTML mode keeps them literal.
    await sendTelegramRichReply("123", "$100 to $200 ==x== ||y|| <b>");

    const [, body] = callsTo("sendRichMessage")[0] ?? [];
    const html = (body?.rich_message as { html: string }).html;
    // The Rich-Markdown extensions survive verbatim, and the angle brackets are
    // escaped rather than emitted as a live <b> tag. (render.test.ts pins the
    // exact character-reference form.)
    expect(html).toContain("$100 to $200 ==x== ||y||");
    expect(html).not.toContain("<b>");
  });

  test("attaches the approval inline keyboard as reply_markup on the rich send", async () => {
    await sendTelegramRichReply("123", "Please approve", approval);

    expect(callTelegramBotApiMock).toHaveBeenCalledWith("sendRichMessage", {
      chat_id: "123",
      rich_message: {
        html: "<p>Please approve</p>",
        skip_entity_detection: true,
      },
      reply_markup: expectedKeyboard,
    });
  });

  test("falls back to plain sendMessage when the rich send is rejected", async () => {
    callTelegramBotApiMock.mockImplementationOnce(async () => {
      throw new TelegramNonRetryableError(
        "Telegram sendRichMessage failed: BLOCK_LIMIT_EXCEEDED",
        "BLOCK_LIMIT_EXCEEDED",
      );
    });

    await sendTelegramRichReply("123", "Too rich for this server");

    // One rejected rich attempt, then one plain-text retry — the user still
    // receives the message.
    expect(callsTo("sendRichMessage")).toHaveLength(1);
    expect(callsTo("sendMessage")).toHaveLength(1);
    expect(callTelegramBotApiMock).toHaveBeenNthCalledWith(2, "sendMessage", {
      chat_id: "123",
      text: "Too rich for this server",
    });
  });

  test("preserves the approval keyboard when falling back to plain text", async () => {
    callTelegramBotApiMock.mockImplementationOnce(async () => {
      throw new TelegramNonRetryableError("rejected", "rejected");
    });

    await sendTelegramRichReply("123", "Please approve", approval);

    expect(callsTo("sendMessage")).toHaveLength(1);
    expect(callTelegramBotApiMock).toHaveBeenNthCalledWith(2, "sendMessage", {
      chat_id: "123",
      text: "Please approve",
      reply_markup: expectedKeyboard,
    });
  });

  test("propagates non-client errors without a plain-text retry", async () => {
    callTelegramBotApiMock.mockImplementationOnce(async () => {
      throw new Error("network down");
    });

    await expect(sendTelegramRichReply("123", "Hello")).rejects.toThrow(
      "network down",
    );

    expect(callsTo("sendRichMessage")).toHaveLength(1);
    expect(callsTo("sendMessage")).toHaveLength(0);
  });
});

describe("sendTelegramReply message id capture", () => {
  test("returns the sent message id so approval cards can be addressed later", async () => {
    callTelegramBotApiMock.mockImplementation(
      async () => ({ message_id: 42 }) as never,
    );

    const result = await sendTelegramReply("123", "Please approve", approval);

    expect(result.lastMessageId).toBe("42");
  });

  test("returns the id of the last chunk for a split message", async () => {
    let nextId = 1;
    callTelegramBotApiMock.mockImplementation(
      async () => ({ message_id: nextId++ }) as never,
    );

    const result = await sendTelegramReply("123", "x".repeat(4500));

    expect(callsTo("sendMessage")).toHaveLength(2);
    expect(result.lastMessageId).toBe("2");
  });

  test("omits the message id when the API response lacks one", async () => {
    const result = await sendTelegramReply("123", "Hello");

    expect(result.lastMessageId).toBeUndefined();
  });
});

describe("telegramTransport.deliver routing", () => {
  const ctx: CallbackContext = { callbackUrl: "/deliver/telegram", params: {} };

  function payload(
    overrides: Partial<ChannelReplyPayload>,
  ): ChannelReplyPayload {
    return {
      chatId: "123",
      text: "hello",
      ...overrides,
    } as ChannelReplyPayload;
  }

  test("routes to the rich send when a rich render is asked for", async () => {
    await telegramTransport.deliver(ctx, payload({ renderRichly: true }));

    expect(callsTo("sendRichMessage")).toHaveLength(1);
    expect(callsTo("sendMessage")).toHaveLength(0);
  });

  test("stays on the plain send when it is not", async () => {
    await telegramTransport.deliver(ctx, payload({ renderRichly: false }));

    expect(callsTo("sendRichMessage")).toHaveLength(0);
    expect(callsTo("sendMessage")).toHaveLength(1);
  });

  test("forwards approval metadata through the rich path", async () => {
    await telegramTransport.deliver(
      ctx,
      payload({ renderRichly: true, approval } as Partial<ChannelReplyPayload>),
    );

    expect(callTelegramBotApiMock).toHaveBeenCalledWith("sendRichMessage", {
      chat_id: "123",
      rich_message: { html: "<p>hello</p>", skip_entity_detection: true },
      reply_markup: expectedKeyboard,
    });
  });
});

describe("telegramTransport topic targeting", () => {
  // A `threadId` param on the deliver callback URL identifies the private-chat
  // topic the inbound message arrived in; every outbound send must echo it.
  const topicCtx: CallbackContext = {
    callbackUrl: "/deliver/telegram?threadId=777",
    params: { threadId: "777" },
  };

  function payload(
    overrides: Partial<ChannelReplyPayload>,
  ): ChannelReplyPayload {
    return {
      chatId: "123",
      text: "hello",
      ...overrides,
    } as ChannelReplyPayload;
  }

  test("plain replies target the topic from the callback threadId param", async () => {
    await telegramTransport.deliver(topicCtx, payload({ renderRichly: false }));

    expect(callTelegramBotApiMock).toHaveBeenCalledWith("sendMessage", {
      chat_id: "123",
      text: "hello",
      message_thread_id: 777,
    });
  });

  test("rich replies target the topic", async () => {
    await telegramTransport.deliver(topicCtx, payload({ renderRichly: true }));

    expect(callTelegramBotApiMock).toHaveBeenCalledWith("sendRichMessage", {
      chat_id: "123",
      rich_message: { html: "<p>hello</p>", skip_entity_detection: true },
      message_thread_id: 777,
    });
  });

  test("the plain-text fallback of a rejected rich send stays in the topic", async () => {
    callTelegramBotApiMock.mockImplementationOnce(async () => {
      throw new TelegramNonRetryableError("rejected", "rejected");
    });

    await telegramTransport.deliver(topicCtx, payload({ renderRichly: true }));

    expect(callTelegramBotApiMock).toHaveBeenNthCalledWith(2, "sendMessage", {
      chat_id: "123",
      text: "hello",
      message_thread_id: 777,
    });
  });

  test("typing indicators target the topic", async () => {
    await telegramTransport.setActivity!(topicCtx, {
      chatId: "123",
      phase: "thinking",
    });

    expect(callTelegramBotApiMock).toHaveBeenCalledWith("sendChatAction", {
      chat_id: "123",
      action: "typing",
      message_thread_id: 777,
    });
  });

  // Telegram's chat action expires on its own, so a phase that is not running
  // has nothing to say. Asserting the call count rather than the absence of a
  // "stop" call is what catches a clearing request being invented later.
  test.each(["idle", "awaiting_confirmation"] as const)(
    "says nothing to Telegram for the %s phase",
    async (phase) => {
      await telegramTransport.setActivity!(topicCtx, {
        chatId: "123",
        phase,
      });

      expect(callTelegramBotApiMock).not.toHaveBeenCalled();
    },
  );

  test("a callback URL without threadId keeps sends thread-less", async () => {
    const bareCtx: CallbackContext = {
      callbackUrl: "/deliver/telegram",
      params: {},
    };

    await telegramTransport.deliver(bareCtx, payload({ renderRichly: false }));
    await telegramTransport.setActivity!(bareCtx, {
      chatId: "123",
      phase: "thinking",
    });

    expect(callTelegramBotApiMock).toHaveBeenCalledWith("sendMessage", {
      chat_id: "123",
      text: "hello",
    });
    expect(callTelegramBotApiMock).toHaveBeenCalledWith("sendChatAction", {
      chat_id: "123",
      action: "typing",
    });
  });
});

describe("editTelegramMessage", () => {
  const ctx = { callbackUrl: "http://gw/deliver/telegram", params: {} };

  const sendMessageCalls = () =>
    callTelegramBotApiMock.mock.calls.filter(
      (call) => call[0] === "sendMessage",
    );

  test("edits in place and never posts a new message", async () => {
    await telegramTransport.edit!(ctx as CallbackContext, {
      chatId: "123",
      messageId: "456",
      text: "revised",
    });

    expect(callTelegramBotApiMock).toHaveBeenCalledTimes(1);
    const [method, body] = callTelegramBotApiMock.mock.calls[0]!;
    expect(method).toBe("editMessageText");
    // Telegram wants a numeric message id, where the capability carries the
    // channel's id as a string.
    expect(body).toEqual({ chat_id: "123", message_id: 456, text: "revised" });
  });

  test("treats an unchanged message as already done", async () => {
    callTelegramBotApiMock.mockImplementationOnce(async () => {
      throw new TelegramNonRetryableError(
        "Bad Request",
        "Bad Request: message is not modified",
      );
    });

    // The edit asked for a state the message is already in, which is the
    // request satisfied rather than refused.
    await expect(
      editTelegramMessage("123", "456", "same"),
    ).resolves.toBeUndefined();
    expect(sendMessageCalls()).toHaveLength(0);
  });

  test("throws on any other rejection rather than posting a replacement", async () => {
    callTelegramBotApiMock.mockImplementationOnce(async () => {
      throw new TelegramNonRetryableError(
        "Bad Request",
        "Bad Request: message to edit not found",
      );
    });

    // Posting instead would leave the original beside a duplicate, so the
    // failure has to reach the caller.
    await expect(editTelegramMessage("123", "456", "gone")).rejects.toThrow();
    expect(sendMessageCalls()).toHaveLength(0);
  });
});
