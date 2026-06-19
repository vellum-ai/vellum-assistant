import { beforeEach, describe, expect, mock, test } from "bun:test";

type CallSlackApi = (
  method: string,
  body: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

const callSlackApiMock = mock<CallSlackApi>(async () => ({ ok: true }));

mock.module("../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("./api.js", () => ({
  callSlackApi: (method: string, body: Record<string, unknown>) =>
    callSlackApiMock(method, body),
  callSlackApiForm: async () => ({}),
  completeSlackUpload: async () => {},
  SlackApiError: class SlackApiError extends Error {
    readonly slackError: string | undefined;

    constructor(slackError: string | undefined) {
      super(slackError ?? "unknown");
      this.slackError = slackError;
    }
  },
  uploadToSlackUrl: async () => {},
}));

const { SlackApiError } = await import("./api.js");
const { sendSlackAssistantThreadStatus, sendSlackReply } =
  await import("./send.js");

describe("sendSlackAssistantThreadStatus", () => {
  beforeEach(() => {
    callSlackApiMock.mockReset();
    callSlackApiMock.mockImplementation(async () => ({ ok: true }));
  });

  test("serializes loading messages for Slack assistant thread status", async () => {
    await sendSlackAssistantThreadStatus(
      "C123",
      "1700000000.000100",
      "is working...",
      ["Reading files", "Running tests"],
    );

    expect(callSlackApiMock).toHaveBeenCalledTimes(1);
    expect(callSlackApiMock).toHaveBeenCalledWith(
      "assistant.threads.setStatus",
      {
        channel_id: "C123",
        thread_ts: "1700000000.000100",
        status: "is working...",
        loading_messages: ["Reading files", "Running tests"],
      },
    );
  });

  test("falls back to the reaction path when status API delivery fails", async () => {
    callSlackApiMock
      .mockImplementationOnce(async () => {
        throw new Error("missing_scope");
      })
      .mockImplementationOnce(async () => ({ ok: true }));

    await sendSlackAssistantThreadStatus(
      "C123",
      "1700000000.000100",
      "is working...",
      ["Reading files"],
    );

    expect(callSlackApiMock).toHaveBeenCalledTimes(2);
    expect(callSlackApiMock).toHaveBeenNthCalledWith(2, "reactions.add", {
      channel: "C123",
      name: "eyes",
      timestamp: "1700000000.000100",
    });
  });
});

describe("sendSlackReply update path", () => {
  const messageTs = "1700000000.000100";
  const blocks = [
    { type: "section", text: { type: "mrkdwn", text: "Final reply" } },
  ];

  beforeEach(() => {
    callSlackApiMock.mockReset();
    callSlackApiMock.mockImplementation(async () => ({ ok: true }));
  });

  test("retries chat.update without blocks on invalid_blocks instead of posting a duplicate", async () => {
    callSlackApiMock
      .mockImplementationOnce(async () => {
        throw new SlackApiError("invalid_blocks");
      })
      .mockImplementationOnce(async () => ({ ok: true, ts: messageTs }));

    const result = await sendSlackReply("C123", "Final reply", {
      messageTs,
      threadTs: "1700000000.000001",
      blocks,
    });

    expect(result).toEqual({ ok: true, ts: messageTs });
    // Two chat.update calls (with then without blocks); never chat.postMessage,
    // so the placeholder is edited in place rather than duplicated.
    expect(callSlackApiMock).toHaveBeenCalledTimes(2);
    expect(callSlackApiMock).toHaveBeenNthCalledWith(1, "chat.update", {
      channel: "C123",
      text: "Final reply",
      ts: messageTs,
      blocks,
    });
    expect(callSlackApiMock).toHaveBeenNthCalledWith(2, "chat.update", {
      channel: "C123",
      text: "Final reply",
      ts: messageTs,
    });
    const postMessageCalls = callSlackApiMock.mock.calls.filter(
      (call) => call[0] === "chat.postMessage",
    );
    expect(postMessageCalls).toHaveLength(0);
  });

  test("falls back to chat.postMessage only after the no-block update retry also fails", async () => {
    callSlackApiMock
      .mockImplementationOnce(async () => {
        throw new SlackApiError("invalid_blocks");
      })
      .mockImplementationOnce(async () => {
        throw new SlackApiError("message_not_found");
      })
      .mockImplementationOnce(async () => ({
        ok: true,
        ts: "1700000000.000200",
      }));

    const result = await sendSlackReply("C123", "Final reply", {
      messageTs,
      threadTs: "1700000000.000001",
      blocks,
    });

    expect(result).toEqual({ ok: true, ts: "1700000000.000200" });
    expect(callSlackApiMock).toHaveBeenCalledTimes(3);
    expect(callSlackApiMock.mock.calls[0]?.[0]).toBe("chat.update");
    expect(callSlackApiMock.mock.calls[1]?.[0]).toBe("chat.update");
    // The post fallback drops the rejected blocks.
    expect(callSlackApiMock).toHaveBeenNthCalledWith(3, "chat.postMessage", {
      channel: "C123",
      text: "Final reply",
      thread_ts: "1700000000.000001",
    });
  });

  test("non-invalid_blocks update failure still falls back to chat.postMessage", async () => {
    callSlackApiMock
      .mockImplementationOnce(async () => {
        throw new SlackApiError("internal_error");
      })
      .mockImplementationOnce(async () => ({
        ok: true,
        ts: "1700000000.000200",
      }));

    const result = await sendSlackReply("C123", "Final reply", {
      messageTs,
      threadTs: "1700000000.000001",
      blocks,
    });

    expect(result).toEqual({ ok: true, ts: "1700000000.000200" });
    // One failed chat.update, then a single chat.postMessage (no extra retry).
    expect(callSlackApiMock).toHaveBeenCalledTimes(2);
    expect(callSlackApiMock.mock.calls[0]?.[0]).toBe("chat.update");
    expect(callSlackApiMock).toHaveBeenNthCalledWith(2, "chat.postMessage", {
      channel: "C123",
      text: "Final reply",
      thread_ts: "1700000000.000001",
      blocks,
    });
  });
});
