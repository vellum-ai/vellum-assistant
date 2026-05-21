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
    slackError?: string;
  },
  uploadToSlackUrl: async () => {},
}));

import { sendSlackAssistantThreadStatus } from "./send.js";

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
