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
const { sendTelegramRichReply, sendTelegramQuestion, editTelegramMessageText } =
  await import("./send.js");
const { telegramTransport } = await import("./transport.js");

const question = {
  requestId: "req-1",
  plainTextFallback: "Which fruit?",
  questions: [
    {
      id: "q1",
      question: "Which fruit?",
      options: [
        { id: "a", label: "Apple" },
        { id: "b", label: "Banana" },
      ],
    },
  ],
};

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

describe("sendTelegramQuestion", () => {
  test("sends a fresh card with the option + Skip keyboard and returns its id", async () => {
    callTelegramBotApiMock.mockImplementationOnce(
      async () => ({ message_id: 101 }) as never,
    );

    const ts = await sendTelegramQuestion(
      "chat-1",
      "Which fruit?",
      question,
      undefined,
    );

    expect(ts).toBe("101");
    expect(callsTo("sendMessage")).toHaveLength(1);
    expect(callsTo("sendMessage")[0][1]).toMatchObject({
      chat_id: "chat-1",
      text: "Which fruit?",
      reply_markup: {
        inline_keyboard: [
          [{ text: "Apple", callback_data: "qst:req-1:q1:0" }],
          [{ text: "Banana", callback_data: "qst:req-1:q1:1" }],
          [{ text: "Skip", callback_data: "qst:req-1:q1:skip" }],
        ],
      },
    });
  });

  test("edits in place to advance when messageTs is set (one call, keyboard included)", async () => {
    const ts = await sendTelegramQuestion(
      "chat-1",
      "Which fruit?",
      question,
      "101",
    );

    expect(ts).toBe("101");
    // A single editMessageText carries both text and keyboard — no separate send.
    expect(callsTo("sendMessage")).toHaveLength(0);
    expect(callsTo("editMessageText")).toHaveLength(1);
    expect(callsTo("editMessageText")[0][1]).toMatchObject({
      chat_id: "chat-1",
      message_id: 101,
      text: "Which fruit?",
      reply_markup: {
        inline_keyboard: [
          [{ text: "Apple", callback_data: "qst:req-1:q1:0" }],
          [{ text: "Banana", callback_data: "qst:req-1:q1:1" }],
          [{ text: "Skip", callback_data: "qst:req-1:q1:skip" }],
        ],
      },
    });
  });

  test("throws when a callback_data would exceed Telegram's 64-byte limit", async () => {
    const longQuestion = {
      requestId: "r".repeat(80),
      plainTextFallback: "Q?",
      questions: [
        {
          id: "q1",
          question: "Q?",
          options: [
            { id: "a", label: "A" },
            { id: "b", label: "B" },
          ],
        },
      ],
    };
    await expect(
      sendTelegramQuestion("chat-1", "Q?", longQuestion, undefined),
    ).rejects.toThrow(/64-byte limit/);
  });
});

describe("editTelegramMessageText", () => {
  test("edits text and clears the keyboard by omitting reply_markup", async () => {
    await editTelegramMessageText("chat-1", "101", "Recorded.");

    expect(callsTo("editMessageText")).toHaveLength(1);
    const body = callsTo("editMessageText")[0][1] as Record<string, unknown>;
    expect(body).toMatchObject({
      chat_id: "chat-1",
      message_id: 101,
      text: "Recorded.",
    });
    // No reply_markup → Telegram removes the inline keyboard.
    expect(body.reply_markup).toBeUndefined();
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

  test("routes to the rich send when useBlocks is set", async () => {
    await telegramTransport.deliver(ctx, payload({ useBlocks: true }));

    expect(callsTo("sendRichMessage")).toHaveLength(1);
    expect(callsTo("sendMessage")).toHaveLength(0);
  });

  test("stays on the plain send when useBlocks is absent", async () => {
    await telegramTransport.deliver(ctx, payload({ useBlocks: false }));

    expect(callsTo("sendRichMessage")).toHaveLength(0);
    expect(callsTo("sendMessage")).toHaveLength(1);
  });

  test("forwards approval metadata through the rich path", async () => {
    await telegramTransport.deliver(
      ctx,
      payload({ useBlocks: true, approval } as Partial<ChannelReplyPayload>),
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
    await telegramTransport.deliver(topicCtx, payload({ useBlocks: false }));

    expect(callTelegramBotApiMock).toHaveBeenCalledWith("sendMessage", {
      chat_id: "123",
      text: "hello",
      message_thread_id: 777,
    });
  });

  test("rich replies target the topic", async () => {
    await telegramTransport.deliver(topicCtx, payload({ useBlocks: true }));

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

    await telegramTransport.deliver(topicCtx, payload({ useBlocks: true }));

    expect(callTelegramBotApiMock).toHaveBeenNthCalledWith(2, "sendMessage", {
      chat_id: "123",
      text: "hello",
      message_thread_id: 777,
    });
  });

  test("typing indicators target the topic", async () => {
    await telegramTransport.sendTyping!(
      topicCtx,
      payload({ chatAction: "typing" }),
    );

    expect(callTelegramBotApiMock).toHaveBeenCalledWith("sendChatAction", {
      chat_id: "123",
      action: "typing",
      message_thread_id: 777,
    });
  });

  test("a callback URL without threadId keeps sends thread-less", async () => {
    const bareCtx: CallbackContext = {
      callbackUrl: "/deliver/telegram",
      params: {},
    };

    await telegramTransport.deliver(bareCtx, payload({ useBlocks: false }));
    await telegramTransport.sendTyping!(
      bareCtx,
      payload({ chatAction: "typing" }),
    );

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
