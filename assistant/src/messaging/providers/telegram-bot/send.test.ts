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
const {
  editTelegramMessage,
  sendTelegramReaction,
  sendTelegramReply,
  sendTelegramRichReply,
  TELEGRAM_DRAFT_TEXT_LIMIT,
} = await import("./send.js");
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

describe("sendTelegramReaction", () => {
  test("add sends setMessageReaction with a single emoji entry", async () => {
    const result = await sendTelegramReaction("12345", "👍", "678", "add");
    expect(result).toEqual({ ok: true });
    const calls = callsTo("setMessageReaction");
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toEqual({
      chat_id: "12345",
      message_id: 678,
      reaction: [{ type: "emoji", emoji: "👍" }],
    });
  });

  test("remove clears the bot's reaction with the empty list", async () => {
    await sendTelegramReaction("12345", "👍", "678", "remove");
    const calls = callsTo("setMessageReaction");
    expect(calls[0][1]).toEqual({
      chat_id: "12345",
      message_id: 678,
      reaction: [],
    });
  });

  test("a non-numeric message id reports ok false without calling the API", async () => {
    const result = await sendTelegramReaction(
      "12345",
      "👍",
      "not-an-id",
      "add",
    );
    expect(result).toEqual({ ok: false });
    expect(callsTo("setMessageReaction")).toHaveLength(0);
  });

  test("an API rejection reports ok false without throwing", async () => {
    callTelegramBotApiMock.mockImplementationOnce(async () => {
      throw new TelegramNonRetryableError("400", "REACTION_INVALID");
    });
    const result = await sendTelegramReaction("12345", "👍", "678", "add");
    expect(result).toEqual({ ok: false });
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
    expect(body).toEqual({
      chat_id: "123",
      message_id: 456,
      text: "revised",
      reply_markup: { inline_keyboard: [] },
    });
  });

  test("clears the inline keyboard, so a settled message keeps no buttons", async () => {
    await telegramTransport.edit!(ctx as CallbackContext, {
      chatId: "123",
      messageId: "456",
      text: "\u2713 Approved",
    });

    const [, body] = callTelegramBotApiMock.mock.calls[0]!;
    // Omitting reply_markup leaves an existing keyboard in place, which would
    // leave live Approve and Reject buttons under text saying the request is
    // already decided. The field has to be sent, and sent empty.
    expect((body as Record<string, unknown>).reply_markup).toEqual({
      inline_keyboard: [],
    });
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

describe("telegramTransport.streamReply", () => {
  const ctx: CallbackContext = {
    callbackUrl: "https://example.test/deliver/telegram?chatId=123",
    params: {},
  };

  test("opens a draft carrying the whole partial reply", async () => {
    const result = await telegramTransport.streamReply?.(ctx, "123", {
      action: "start",
      text: "Looking that up",
      appended: "Looking that up",
    });

    const calls = callsTo("sendMessageDraft");
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]).toMatchObject({
      chat_id: 123,
      text: "Looking that up",
    });
    // The id is minted here, not handed back by Telegram, and must be usable
    // as the stream id the later append addresses.
    expect(Number(result?.ts)).toBeGreaterThan(0);
    expect(result?.ok).toBe(true);
  });

  test("advances one draft by resending the whole text under the same id", async () => {
    await telegramTransport.streamReply?.(ctx, "123", {
      action: "append",
      streamId: "4242",
      text: "Looking that up. Found it.",
      appended: ". Found it.",
    });

    const calls = callsTo("sendMessageDraft");
    expect(calls).toHaveLength(1);
    // Telegram animates between drafts sharing an id, so the call carries the
    // whole reply so far rather than the delta.
    expect(calls[0]![1]).toMatchObject({
      chat_id: 123,
      draft_id: 4242,
      text: "Looking that up. Found it.",
    });
  });

  test("draws a plan into the draft, since Telegram has no task primitive", async () => {
    await telegramTransport.streamReply?.(ctx, "123", {
      action: "append",
      streamId: "4242",
      text: "Working.",
      plan: {
        title: "Answering",
        steps: [
          { label: "Search docs", status: "completed" },
          { label: "Summarize", status: "in_progress" },
          { label: "Reply", status: "pending" },
        ],
      },
    });

    const body = callsTo("sendMessageDraft")[0]![1] as { text: string };
    expect(body.text).toBe(
      "Working.\n\nAnswering\n✓ Search docs\n▸ Summarize\n· Reply",
    );
  });

  test("stopping does nothing, because sending the reply clears the draft", async () => {
    const result = await telegramTransport.streamReply?.(ctx, "123", {
      action: "stop",
      streamId: "4242",
      text: "All done.",
    });

    expect(callsTo("sendMessageDraft")).toHaveLength(0);
    expect(result).toEqual({ ok: true, ts: "4242" });
  });

  test("sends the chat id as the integer the draft method requires", async () => {
    // `sendMessageDraft` takes an Integer chat_id, not the "Integer or String"
    // most methods accept, so the string the transport carries has to become a
    // number on the wire.
    await telegramTransport.streamReply?.(ctx, "123", {
      action: "start",
      text: "Hi",
      appended: "Hi",
    });

    const body = callsTo("sendMessageDraft")[0]![1] as { chat_id: unknown };
    expect(body.chat_id).toBe(123);
  });

  test("refuses a chat id that cannot be an integer, without calling out", async () => {
    const result = await telegramTransport.streamReply?.(ctx, "@somechannel", {
      action: "start",
      text: "Hi",
      appended: "Hi",
    });

    expect(callsTo("sendMessageDraft")).toHaveLength(0);
    expect(result).toEqual({ ok: false });
  });

  test("a draft past the cap keeps its live tail, not a frozen prefix", async () => {
    // Telegram caps a draft at 4096. Keeping the head would freeze the preview
    // the moment the reply passed the cap, and would cut off anything drawn
    // beneath it; the tail is the part still moving.
    const body = "HEADMARK" + "a".repeat(5_000);
    await telegramTransport.streamReply?.(ctx, "123", {
      action: "append",
      streamId: "4242",
      text: body + "TAILMARK",
      appended: "TAILMARK",
      plan: { steps: [{ label: "Summarize", status: "in_progress" }] },
    });

    const sent = (callsTo("sendMessageDraft")[0]![1] as { text: string }).text;
    expect(sent.length).toBe(TELEGRAM_DRAFT_TEXT_LIMIT);
    // The newest text and the plan beneath it survive; the stale head is what
    // gets dropped, which is the opposite of a frozen prefix.
    expect(sent).toContain("TAILMARK");
    expect(sent).toContain("Summarize");
    expect(sent).not.toContain("HEADMARK");
  });

  test("a trimmed draft never begins with half of a character", async () => {
    // The cap counts UTF-16 code units, so a tail cut can land between the
    // halves of an emoji and send a lone surrogate.
    const emoji = "\u{1F600}";
    const body = emoji.repeat(3_000);
    await telegramTransport.streamReply?.(ctx, "123", {
      action: "append",
      streamId: "4242",
      text: body,
      appended: emoji,
    });

    const sent = (callsTo("sendMessageDraft")[0]![1] as { text: string }).text;
    const first = sent.charCodeAt(0);
    expect(first >= 0xdc00 && first <= 0xdfff).toBe(false);
    expect(sent.length).toBeLessThanOrEqual(TELEGRAM_DRAFT_TEXT_LIMIT);
  });

  test("a refused draft reports not-ok so the caller falls back", async () => {
    // Telegram offers drafts in private chats only; anywhere else the call is
    // rejected, and that rejection is the whole of the per-conversation rule.
    callTelegramBotApiMock.mockImplementation(async () => {
      throw new Error("Bad Request: chat type is not supported");
    });

    const result = await telegramTransport.streamReply?.(ctx, "123", {
      action: "start",
      text: "Looking that up",
      appended: "Looking that up",
    });

    expect(result).toEqual({ ok: false });
  });
});
