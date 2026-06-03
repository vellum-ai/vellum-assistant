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
const { sendSlackAssistantThreadStatus, sendSlackReply } = await import(
  "./send.js"
);

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

describe("sendSlackReply", () => {
  beforeEach(() => {
    callSlackApiMock.mockReset();
    callSlackApiMock.mockImplementation(async () => ({ ok: true }));
  });

  test("falls back to chat.postMessage for retryable update-target failures when enabled", async () => {
    const err = new SlackApiError("message_not_found");

    callSlackApiMock
      .mockImplementationOnce(async () => {
        throw err;
      })
      .mockImplementationOnce(async () => ({ ok: true, ts: "1700000000.000200" }));

    const result = await sendSlackReply("C123", "Final reply", {
      messageTs: "1700000000.000100",
      threadTs: "1700000000.000001",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "Final reply" } }],
      allowUpdateFailureFallbackToPost: true,
    });

    expect(result).toEqual({ ok: true, ts: "1700000000.000200" });
    expect(callSlackApiMock).toHaveBeenCalledTimes(2);
    expect(callSlackApiMock).toHaveBeenNthCalledWith(1, "chat.update", {
      channel: "C123",
      text: "Final reply",
      ts: "1700000000.000100",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "Final reply" } }],
    });
    expect(callSlackApiMock).toHaveBeenNthCalledWith(2, "chat.postMessage", {
      channel: "C123",
      text: "Final reply",
      thread_ts: "1700000000.000001",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "Final reply" } }],
    });
  });

  test("keeps update failures strict when post fallback is not allowed", async () => {
    const err = new SlackApiError("message_not_found");
    callSlackApiMock.mockImplementationOnce(async () => {
      throw err;
    });

    await expect(
      sendSlackReply("C123", "Edited reply", {
        messageTs: "1700000000.000100",
        threadTs: "1700000000.000001",
      }),
    ).rejects.toBe(err);

    expect(callSlackApiMock).toHaveBeenCalledTimes(1);
    expect(callSlackApiMock).toHaveBeenNthCalledWith(1, "chat.update", {
      channel: "C123",
      text: "Edited reply",
      ts: "1700000000.000100",
    });
  });

  test("falls back to chat.postMessage when the no-block update retry hits message_not_found", async () => {
    const invalidBlocksErr = new SlackApiError("invalid_blocks");
    const missingMessageErr = new SlackApiError("message_not_found");

    callSlackApiMock
      .mockImplementationOnce(async () => {
        throw invalidBlocksErr;
      })
      .mockImplementationOnce(async () => {
        throw missingMessageErr;
      })
      .mockImplementationOnce(async () => ({ ok: true, ts: "1700000000.000300" }));

    const result = await sendSlackReply("C123", "Fallback reply", {
      messageTs: "1700000000.000100",
      threadTs: "1700000000.000001",
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: "Fallback reply" } },
      ],
      allowUpdateFailureFallbackToPost: true,
    });

    expect(result).toEqual({ ok: true, ts: "1700000000.000300" });
    expect(callSlackApiMock).toHaveBeenCalledTimes(3);
    expect(callSlackApiMock.mock.calls[0]?.[0]).toBe("chat.update");
    expect(callSlackApiMock).toHaveBeenNthCalledWith(2, "chat.update", {
      channel: "C123",
      text: "Fallback reply",
      ts: "1700000000.000100",
    });
    expect(callSlackApiMock).toHaveBeenNthCalledWith(3, "chat.postMessage", {
      channel: "C123",
      text: "Fallback reply",
      thread_ts: "1700000000.000001",
    });
  });
});
