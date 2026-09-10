import { beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  ChannelTransport,
  ProactiveTarget,
} from "../../messaging/providers/channel-transport.js";

// The seam under test is the send function: it must ask the transport for
// the address, deliver through it, and record only what the channel
// acknowledged. The transport is a fake registered by channel id; the
// recording dependencies are stubbed so the tests read what was recorded.

const deliverCalls: Array<{
  ctx: { callbackUrl: string; params: Record<string, string> };
  payload: Record<string, unknown>;
}> = [];
let deliverResult: Record<string, unknown> = {
  ok: true,
  ts: "1700000000.000100",
  messageIds: ["1700000000.000100"],
};

function fakeTransport(
  channel: "slack" | "telegram",
  opts: { binds?: boolean; addressable?: boolean; refuses?: boolean } = {},
): ChannelTransport {
  const transport: ChannelTransport = {
    channel,
    async deliver(ctx, payload) {
      deliverCalls.push({
        ctx: { callbackUrl: ctx.callbackUrl, params: { ...ctx.params } },
        payload: payload as unknown as Record<string, unknown>,
      });
      return deliverResult as unknown as Awaited<
        ReturnType<ChannelTransport["deliver"]>
      >;
    },
  };
  if (opts.addressable !== false) {
    transport.addressFor = (target: ProactiveTarget) => {
      if (opts.refuses) {
        return undefined;
      }
      const threadId = target.threadId?.trim();
      const params: Record<string, string> = threadId ? { threadId } : {};
      return {
        ctx: { callbackUrl: `/deliver/${channel}`, params },
        chatId: target.chatId,
        ...(threadId ? { threadId } : {}),
      };
    };
  }
  if (opts.binds) {
    (
      transport as { bindsChatOnProactiveSend?: boolean }
    ).bindsChatOnProactiveSend = true;
  }
  return transport;
}

let transports: Record<string, ChannelTransport> = {};
mock.module("../../messaging/providers/index.js", () => ({
  getTransportForChannel: (channel: string | undefined) =>
    channel ? transports[channel] : undefined,
}));

const resolveHomeMock = mock(async (_params: Record<string, unknown>) => ({
  conversationId: "home-1",
  createdNewConversation: false,
}));
const recordMock = mock(async (_post: Record<string, unknown>) => ({
  messageId: "row-1",
}));
const bindCalls: Array<Record<string, unknown>> = [];
const getOrCreateCalls: string[] = [];

mock.module("../../notifications/conversation-pairing.js", () => ({
  resolveProactiveHomeConversation: resolveHomeMock,
}));
mock.module("../../notifications/delivered-post-record.js", () => ({
  recordDeliveredChannelPost: recordMock,
}));
mock.module("../../persistence/conversation-crud.js", () => ({
  getConversation: (id: string) => ({ id, createdAt: 1700000000000 }),
}));
mock.module("../../persistence/conversation-disk-view.js", () => ({
  syncMessageToDisk: () => {},
}));
let bindCreates = true;
let bindThrows = false;
mock.module("../../persistence/conversation-key-store.js", () => ({
  getOrCreateConversation: (key: string) => {
    getOrCreateCalls.push(key);
    return { conversationId: `conv-for-${key}`, created: bindCreates };
  },
}));
const listChangedMock = mock((_reason: string) => {});
const actualSync = await import("../sync/resource-sync-events.js");
mock.module("../sync/resource-sync-events.js", () => ({
  ...actualSync,
  publishConversationListChanged: listChangedMock,
}));
mock.module("../../persistence/delivery-crud.js", () => ({
  buildScopedConversationKey: (
    channel: string,
    chatId: string,
    threadId?: string | null,
  ) =>
    threadId
      ? `asst:self:${channel}:${chatId}:thread:${threadId}`
      : `asst:self:${channel}:${chatId}`,
}));
mock.module("../../persistence/external-conversation-store.js", () => ({
  normalizeExternalThreadId: (value: string | null | undefined) => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
  },
  upsertOutboundBinding: (input: Record<string, unknown>) => {
    if (bindThrows) {
      throw new Error("binding store unavailable");
    }
    bindCalls.push(input);
  },
}));

const {
  ChannelNotAddressableError,
  ChannelSendFailedError,
  isProactivelyAddressable,
  sendChannelText,
} = await import("../channel-send.js");

beforeEach(() => {
  deliverCalls.length = 0;
  bindCalls.length = 0;
  getOrCreateCalls.length = 0;
  bindCreates = true;
  bindThrows = false;
  listChangedMock.mockClear();
  resolveHomeMock.mockClear();
  recordMock.mockClear();
  deliverResult = {
    ok: true,
    ts: "1700000000.000100",
    messageIds: ["1700000000.000100"],
  };
  transports = {
    slack: fakeTransport("slack"),
    telegram: fakeTransport("telegram", { binds: true }),
  };
});

const sender = {
  conversationId: "conv-A",
  executionChannel: "slack",
  requesterChatId: "C123",
  sourceThreadId: "1690000000.000001",
};

describe("addressability", () => {
  test("a channel is addressable exactly when its transport declares it", () => {
    transports.a2a = fakeTransport("slack", { addressable: false });
    expect(isProactivelyAddressable("slack")).toBe(true);
    expect(isProactivelyAddressable("a2a")).toBe(false);
    expect(isProactivelyAddressable("email")).toBe(false);
    expect(isProactivelyAddressable("not-a-channel")).toBe(false);
  });

  test("refuses before delivery when the channel has no addressing, or refuses the chat", async () => {
    await expect(
      sendChannelText({
        channel: "email",
        target: { kind: "chat", chatId: "x" },
        text: "hi",
      }),
    ).rejects.toBeInstanceOf(ChannelNotAddressableError);

    transports.slack = fakeTransport("slack", { refuses: true });
    await expect(
      sendChannelText({
        channel: "slack",
        target: { kind: "chat", chatId: "C-unreachable" },
        text: "hi",
      }),
    ).rejects.toBeInstanceOf(ChannelNotAddressableError);
    expect(deliverCalls).toEqual([]);
  });
});

describe("delivery through the transport", () => {
  test("delivers to the address the transport resolves, with the rich render asked for", async () => {
    const result = await sendChannelText({
      channel: "slack",
      target: { kind: "chat", chatId: "C123", threadId: "1690000000.000001" },
      text: "hello",
      renderRichly: true,
      assistantId: "self",
    });

    expect(deliverCalls).toEqual([
      {
        ctx: {
          callbackUrl: "/deliver/slack",
          params: { threadId: "1690000000.000001" },
        },
        payload: {
          chatId: "C123",
          text: "hello",
          renderRichly: true,
          assistantId: "self",
        },
      },
    ]);
    expect(result).toMatchObject({
      channel: "slack",
      chatId: "C123",
      threadId: "1690000000.000001",
      messageIds: ["1700000000.000100"],
      lastMessageId: "1700000000.000100",
    });
  });

  test("a send the channel does not acknowledge fails and records nothing", async () => {
    deliverResult = { ok: false };
    await expect(
      sendChannelText({
        channel: "slack",
        target: { kind: "chat", chatId: "C123" },
        text: "hello",
      }),
    ).rejects.toBeInstanceOf(ChannelSendFailedError);
    expect(recordMock).not.toHaveBeenCalled();
  });

  test("binds the chat's inbound conversation after acknowledgement, only where the transport declares it", async () => {
    await sendChannelText({
      channel: "telegram",
      target: { kind: "chat", chatId: "123456789" },
      text: "hello",
    });
    expect(getOrCreateCalls).toEqual(["asst:self:telegram:123456789"]);
    expect(bindCalls).toEqual([
      {
        conversationId: "conv-for-asst:self:telegram:123456789",
        sourceChannel: "telegram",
        externalChatId: "123456789",
        externalThreadId: null,
      },
    ]);

    bindCalls.length = 0;
    await sendChannelText({
      channel: "slack",
      target: { kind: "chat", chatId: "C123" },
      text: "hello",
    });
    expect(bindCalls).toEqual([]);
  });

  test("a topic send binds the topic's own conversation, the one its replies resolve to", async () => {
    await sendChannelText({
      channel: "telegram",
      target: { kind: "chat", chatId: "123456789", threadId: "42" },
      text: "hello",
    });
    expect(getOrCreateCalls).toEqual([
      "asst:self:telegram:123456789:thread:42",
    ]);
    expect(bindCalls).toEqual([
      {
        conversationId: "conv-for-asst:self:telegram:123456789:thread:42",
        sourceChannel: "telegram",
        externalChatId: "123456789",
        externalThreadId: "42",
      },
    ]);
  });

  test("a conversation the binding mints reaches the list; one it finds does not", async () => {
    await sendChannelText({
      channel: "telegram",
      target: { kind: "chat", chatId: "123456789", threadId: "42" },
      text: "hello",
    });
    expect(listChangedMock).toHaveBeenCalledTimes(1);
    expect(listChangedMock).toHaveBeenCalledWith("created");

    listChangedMock.mockClear();
    bindCreates = false;
    await sendChannelText({
      channel: "telegram",
      target: { kind: "chat", chatId: "123456789", threadId: "42" },
      text: "again",
    });
    expect(listChangedMock).not.toHaveBeenCalled();
  });

  test("a binding that throws still leaves its minted conversation in the list", async () => {
    bindThrows = true;
    const result = await sendChannelText({
      channel: "telegram",
      target: { kind: "chat", chatId: "123456789", threadId: "42" },
      text: "hello",
    });
    expect(bindCalls).toEqual([]);
    expect(listChangedMock).toHaveBeenCalledWith("created");
    expect(result.messageIds).toEqual(["1700000000.000100"]);
  });

  test("a failed send binds nothing, so it does not move where the next inbound lands", async () => {
    deliverResult = { ok: false };
    await expect(
      sendChannelText({
        channel: "telegram",
        target: { kind: "chat", chatId: "123456789" },
        text: "hello",
      }),
    ).rejects.toBeInstanceOf(ChannelSendFailedError);
    expect(getOrCreateCalls).toEqual([]);
    expect(bindCalls).toEqual([]);
  });

  test("does not bind a chat when acting for another assistant", async () => {
    await sendChannelText({
      channel: "telegram",
      target: { kind: "chat", chatId: "123456789" },
      text: "hello",
      assistantId: "asst-other",
    });
    expect(bindCalls).toEqual([]);
  });
});

describe("recording after acknowledgement", () => {
  test("records every acknowledged id in the chat's home, cross-posted from the sender", async () => {
    deliverResult = { ok: true, messageIds: ["10", "11", "12"] };
    const result = await sendChannelText({
      channel: "telegram",
      target: { kind: "chat", chatId: "123456789" },
      text: "a long message",
      sender: { conversationId: "conv-A" },
    });

    expect(resolveHomeMock.mock.calls[0]![0]).toMatchObject({
      sourceChannel: "telegram",
      externalChatId: "123456789",
    });
    expect(recordMock).toHaveBeenCalledTimes(1);
    expect(recordMock.mock.calls[0]![0]).toEqual({
      conversationId: "home-1",
      channel: "telegram",
      externalChatId: "123456789",
      text: "a long message",
      providerMessageId: "10",
      additionalProviderMessageIds: ["11", "12"],
      crossPostedFrom: "conv-A",
    });
    expect(result).toMatchObject({
      messageIds: ["10", "11", "12"],
      lastMessageId: "12",
      recordedIn: "home-1",
    });
  });

  test("a success that names no message id is not an acknowledgement", async () => {
    deliverResult = { ok: true, messageIds: [] };
    await expect(
      sendChannelText({
        channel: "slack",
        target: { kind: "chat", chatId: "C123" },
        text: "hello",
      }),
    ).rejects.toThrow("acknowledged no message id");
    expect(recordMock).not.toHaveBeenCalled();
  });

  test("records nothing when the post landed in the turn's own chat and thread", async () => {
    await sendChannelText({
      channel: "slack",
      target: { kind: "chat", chatId: "C123", threadId: "1690000000.000001" },
      text: "hello",
      sender,
    });
    expect(resolveHomeMock).not.toHaveBeenCalled();
    expect(recordMock).not.toHaveBeenCalled();
  });

  test("a send into the turn's chat but a different thread is a cross-post, recorded in that thread", async () => {
    await sendChannelText({
      channel: "slack",
      target: { kind: "chat", chatId: "C123", threadId: "1690000000.000009" },
      text: "hello",
      sender,
    });
    expect(resolveHomeMock.mock.calls[0]![0]).toMatchObject({
      sourceChannel: "slack",
      externalChatId: "C123",
      threadId: "1690000000.000009",
    });
    expect(recordMock).toHaveBeenCalledTimes(1);
    expect(recordMock.mock.calls[0]![0]).toMatchObject({
      externalChatId: "C123",
      threadId: "1690000000.000009",
    });
  });

  test("a thread-less delivery never matches a turn that arrived in a thread", async () => {
    await sendChannelText({
      channel: "slack",
      target: { kind: "chat", chatId: "C123" },
      text: "hello",
      sender,
    });
    expect(recordMock).toHaveBeenCalledTimes(1);
  });

  test("a sender that arrived through no channel falls back to the home comparison", async () => {
    resolveHomeMock.mockImplementationOnce(async () => ({
      conversationId: "conv-A",
      createdNewConversation: false,
    }));
    await sendChannelText({
      channel: "slack",
      target: { kind: "chat", chatId: "C123" },
      text: "hello",
      sender: { conversationId: "conv-A" },
    });
    expect(recordMock).not.toHaveBeenCalled();
  });

  test("a recording failure does not fail the send", async () => {
    recordMock.mockImplementationOnce(async () => {
      throw new Error("db unavailable");
    });
    const result = await sendChannelText({
      channel: "slack",
      target: { kind: "chat", chatId: "C123" },
      text: "hello",
    });
    expect(result.messageIds).toEqual(["1700000000.000100"]);
    expect(result.recordedIn).toBeUndefined();
  });
});
