import { beforeEach, describe, expect, mock, test } from "bun:test";

// The route is a thin door over the send function: it validates the body
// against its declared schema and maps the function's refusals onto route
// errors, so the CLI and the messaging tool share one seam.

const sendCalls: Array<Record<string, unknown>> = [];
let sendImpl: (params: Record<string, unknown>) => Promise<unknown> = async (
  params,
) => ({
  channel: params.channel,
  chatId: "C123",
  messageIds: ["1700000000.000100"],
  lastMessageId: "1700000000.000100",
  recordedIn: "home-1",
});

class ChannelNotAddressableError extends Error {}
class ChannelSendFailedError extends Error {}

mock.module("../../channel-send.js", () => ({
  ChannelNotAddressableError,
  ChannelSendFailedError,
  sendChannelText: async (params: Record<string, unknown>) => {
    sendCalls.push(params);
    return sendImpl(params);
  },
}));

const { ROUTES } = await import("../channel-send-routes.js");
const { BadGatewayError, BadRequestError } = await import("../errors.js");

const route = ROUTES.find((r) => r.operationId === "channels_send_post")!;

beforeEach(() => {
  sendCalls.length = 0;
});

describe("POST channels/send", () => {
  test("is registered as a chat write for actor principals", () => {
    expect(route).toBeDefined();
    expect(route.endpoint).toBe("channels/send");
    expect(route.method).toBe("POST");
    expect(route.policy?.requiredScopes).toEqual(["chat.write"]);
  });

  test("hands a valid body to the send function and returns its result", async () => {
    const body = {
      channel: "slack",
      target: { kind: "chat", chatId: "C123", threadId: "1690000000.000001" },
      text: "hello",
      renderRichly: true,
    };
    const result = await route.handler({ body });
    expect(sendCalls).toEqual([body]);
    expect(result).toMatchObject({
      channel: "slack",
      messageIds: ["1700000000.000100"],
      recordedIn: "home-1",
    });
  });

  test("names no sending turn, so a caller cannot claim a send was its own chat's", async () => {
    await route.handler({
      body: {
        channel: "slack",
        target: { kind: "chat", chatId: "C123" },
        text: "hello",
        sender: {
          conversationId: "conv-A",
          executionChannel: "slack",
          requesterChatId: "C123",
        },
      },
    });
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]).not.toHaveProperty("sender");
  });

  test("rejects a malformed body before calling the send function", async () => {
    await expect(
      route.handler({
        body: { channel: "slack", target: { kind: "chat" }, text: "" },
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
    await expect(
      route.handler({
        body: {
          channel: "not-a-channel",
          target: { kind: "chat", chatId: "C1" },
          text: "hi",
        },
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(sendCalls).toEqual([]);
  });

  test("maps the send function's refusals onto route errors", async () => {
    sendImpl = async () => {
      throw new ChannelNotAddressableError(
        'Channel "email" is not addressable',
      );
    };
    await expect(
      route.handler({
        body: {
          channel: "email",
          target: { kind: "chat", chatId: "x" },
          text: "hi",
        },
      }),
    ).rejects.toBeInstanceOf(BadRequestError);

    sendImpl = async () => {
      throw new ChannelSendFailedError("not acknowledged");
    };
    await expect(
      route.handler({
        body: {
          channel: "slack",
          target: { kind: "chat", chatId: "C1" },
          text: "hi",
        },
      }),
    ).rejects.toBeInstanceOf(BadGatewayError);
  });
});
