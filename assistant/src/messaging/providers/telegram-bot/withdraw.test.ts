import { beforeEach, describe, expect, mock, test } from "bun:test";

// Derive the mock signature from the real export so the test cannot drift from
// the production call signature.
type CallTelegramBotApi = typeof import("./api.js").callTelegramBotApi;

const callTelegramBotApiMock = mock<CallTelegramBotApi>(
  async () => ({}) as never,
);

mock.module("./api.js", () => ({
  callTelegramBotApi: (method: string, body: Record<string, unknown>) =>
    callTelegramBotApiMock(method, body),
}));

const { withdrawTelegramApprovalCard } = await import("./withdraw.js");

const callsTo = (method: string) =>
  callTelegramBotApiMock.mock.calls.filter((call) => call[0] === method);

beforeEach(() => {
  callTelegramBotApiMock.mockReset();
  callTelegramBotApiMock.mockImplementation(async () => ({}) as never);
});

describe("withdrawTelegramApprovalCard", () => {
  test("clears the inline keyboard and posts a silent quoted status reply", async () => {
    await withdrawTelegramApprovalCard({
      chatId: "chat-1",
      messageId: "42",
      status: "approved",
      postStatusReply: true,
    });

    const edits = callsTo("editMessageReplyMarkup");
    expect(edits).toHaveLength(1);
    expect(edits[0]?.[1]).toEqual({
      chat_id: "chat-1",
      message_id: 42,
      reply_markup: null,
    });

    const sends = callsTo("sendMessage");
    expect(sends).toHaveLength(1);
    expect(sends[0]?.[1]).toEqual({
      chat_id: "chat-1",
      text: "✅ Approved",
      reply_parameters: { message_id: 42, allow_sending_without_reply: true },
      disable_notification: true,
    });
  });

  test("skips the status reply when the decision originated on Telegram", async () => {
    await withdrawTelegramApprovalCard({
      chatId: "chat-1",
      messageId: "42",
      status: "denied",
      postStatusReply: false,
    });

    expect(callsTo("editMessageReplyMarkup")).toHaveLength(1);
    expect(callsTo("sendMessage")).toHaveLength(0);
  });

  test("falls back to an empty inline keyboard when the null form is rejected", async () => {
    callTelegramBotApiMock.mockImplementationOnce(async () => {
      throw new Error("Bad Request: REPLY_MARKUP_INVALID");
    });

    await withdrawTelegramApprovalCard({
      chatId: "chat-1",
      messageId: "7",
      status: "expired",
      postStatusReply: true,
    });

    const edits = callsTo("editMessageReplyMarkup");
    expect(edits).toHaveLength(2);
    expect(edits[1]?.[1]).toEqual({
      chat_id: "chat-1",
      message_id: 7,
      reply_markup: { inline_keyboard: [] },
    });
    expect(callsTo("sendMessage")).toHaveLength(1);
    expect(callsTo("sendMessage")[0]?.[1]).toMatchObject({
      text: "⌛ Expired",
    });
  });

  test("treats 'message is not modified' as already cleared", async () => {
    callTelegramBotApiMock.mockImplementationOnce(async () => {
      throw new Error("Bad Request: message is not modified");
    });

    await withdrawTelegramApprovalCard({
      chatId: "chat-1",
      messageId: "7",
      status: "approved",
      postStatusReply: true,
    });

    // No empty-keyboard retry: the keyboard is already gone.
    expect(callsTo("editMessageReplyMarkup")).toHaveLength(1);
    expect(callsTo("sendMessage")).toHaveLength(1);
  });

  test("still posts the status reply when both keyboard edits fail", async () => {
    callTelegramBotApiMock.mockImplementation(
      async (method: string): Promise<never> => {
        if (method === "editMessageReplyMarkup") {
          throw new Error("Bad Request: message to edit not found");
        }
        return {} as never;
      },
    );

    await withdrawTelegramApprovalCard({
      chatId: "chat-1",
      messageId: "7",
      status: "approved",
      postStatusReply: true,
    });

    expect(callsTo("editMessageReplyMarkup")).toHaveLength(2);
    expect(callsTo("sendMessage")).toHaveLength(1);
  });

  test("renders a parked denial with the neutral park label", async () => {
    await withdrawTelegramApprovalCard({
      chatId: "chat-1",
      messageId: "9",
      status: "denied",
      decidedAction: "leave_unverified",
      postStatusReply: true,
    });

    expect(callsTo("sendMessage")[0]?.[1]).toMatchObject({
      text: "⏸️ Left unverified",
    });
  });

  test("skips everything on a non-numeric message id", async () => {
    await withdrawTelegramApprovalCard({
      chatId: "chat-1",
      messageId: "not-a-number",
      status: "approved",
      postStatusReply: true,
    });

    expect(callTelegramBotApiMock.mock.calls).toHaveLength(0);
  });
});
