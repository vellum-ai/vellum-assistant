import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { KnownBlock } from "@slack/types";

// Derive the mock signature from the real export so it cannot drift from the
// production response shape (`SlackApiResponse`). A hand-rolled
// `Promise<Record<string, unknown>>` here would let a test pass against a
// response shape production never actually returns.
type CallSlackApi = typeof import("./api.js").callSlackApi;

const callSlackApiMock = mock<CallSlackApi>(async () => ({ ok: true }));

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
  startSlackStream: (params: { markdownText?: string }) =>
    callSlackApiMock("chat.startStream", { ...params }),
  appendSlackStream: (params: { markdownText?: string }) =>
    callSlackApiMock("chat.appendStream", { ...params }),
  stopSlackStream: (params: { markdownText?: string }) =>
    callSlackApiMock("chat.stopStream", { ...params }),
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
  const threadTs = "1700000000.000001";
  const blocks: KnownBlock[] = [
    { type: "section", text: { type: "mrkdwn", text: "Final reply" } },
  ];

  const postMessageCalls = () =>
    callSlackApiMock.mock.calls.filter(
      (call) => call[0] === "chat.postMessage",
    );

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
      threadTs,
      blocks,
    });

    expect(result).toEqual({ ok: true, ts: messageTs });
    // Two chat.update calls (with then without blocks); never chat.postMessage,
    // so the message is edited in place rather than duplicated.
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
    expect(postMessageCalls()).toHaveLength(0);
  });

  test("throws when the no-block update retry also fails, never posting a duplicate", async () => {
    callSlackApiMock
      .mockImplementationOnce(async () => {
        throw new SlackApiError("invalid_blocks");
      })
      .mockImplementationOnce(async () => {
        throw new SlackApiError("message_not_found");
      });

    await expect(
      sendSlackReply("C123", "Final reply", { messageTs, threadTs, blocks }),
    ).rejects.toThrow();

    // Two in-place chat.update attempts (with then without blocks), then give
    // up — it must not fall back to chat.postMessage and duplicate the message.
    expect(callSlackApiMock).toHaveBeenCalledTimes(2);
    expect(callSlackApiMock.mock.calls[0]?.[0]).toBe("chat.update");
    expect(callSlackApiMock.mock.calls[1]?.[0]).toBe("chat.update");
    expect(postMessageCalls()).toHaveLength(0);
  });

  test("throws on a transient chat.update failure instead of posting a duplicate", async () => {
    callSlackApiMock.mockImplementationOnce(async () => {
      throw new SlackApiError("internal_error");
    });

    await expect(
      sendSlackReply("C123", "Final reply", { messageTs, threadTs, blocks }),
    ).rejects.toThrow();

    // A single failed chat.update, no chat.postMessage fallback: a transient
    // failure must not spawn a "ghost" reply beside the message we failed to
    // edit. Re-delivery is the delivery layer's job.
    expect(callSlackApiMock).toHaveBeenCalledTimes(1);
    expect(callSlackApiMock.mock.calls[0]?.[0]).toBe("chat.update");
    expect(postMessageCalls()).toHaveLength(0);
  });

  test("throws when the edit target is gone rather than re-posting it", async () => {
    // Even when the target message no longer exists, this function does not
    // post a fresh one — re-delivery is owned by the delivery layer, which
    // would otherwise double-post.
    callSlackApiMock.mockImplementationOnce(async () => {
      throw new SlackApiError("message_not_found");
    });

    await expect(
      sendSlackReply("C123", "Final reply", { messageTs, threadTs, blocks }),
    ).rejects.toThrow();

    expect(callSlackApiMock).toHaveBeenCalledTimes(1);
    expect(callSlackApiMock.mock.calls[0]?.[0]).toBe("chat.update");
    expect(postMessageCalls()).toHaveLength(0);
  });
});

describe("sendSlackReply post path", () => {
  const threadTs = "1700000000.000001";
  const blocks: KnownBlock[] = [
    { type: "section", text: { type: "mrkdwn", text: "Fresh reply" } },
  ];

  beforeEach(() => {
    callSlackApiMock.mockReset();
    callSlackApiMock.mockImplementation(async () => ({ ok: true }));
  });

  test("retries chat.postMessage without blocks on invalid_blocks", async () => {
    callSlackApiMock
      .mockImplementationOnce(async () => {
        throw new SlackApiError("invalid_blocks");
      })
      .mockImplementationOnce(async () => ({
        ok: true,
        ts: "1700000000.000200",
      }));

    const result = await sendSlackReply("C123", "Fresh reply", {
      threadTs,
      blocks,
    });

    expect(result).toEqual({ ok: true, ts: "1700000000.000200" });
    // Two chat.postMessage calls (with then without blocks); never chat.update.
    expect(callSlackApiMock).toHaveBeenCalledTimes(2);
    expect(callSlackApiMock).toHaveBeenNthCalledWith(1, "chat.postMessage", {
      channel: "C123",
      text: "Fresh reply",
      thread_ts: threadTs,
      blocks,
    });
    expect(callSlackApiMock).toHaveBeenNthCalledWith(2, "chat.postMessage", {
      channel: "C123",
      text: "Fresh reply",
      thread_ts: threadTs,
    });
    expect(
      callSlackApiMock.mock.calls.filter((call) => call[0] === "chat.update"),
    ).toHaveLength(0);
  });

  test("retries chat.postMessage without blocks on msg_blocks_too_long", async () => {
    // Cumulative block text over Slack's ~13k ceiling comes back as
    // `msg_blocks_too_long`, not `invalid_blocks`; it must still degrade to text.
    callSlackApiMock
      .mockImplementationOnce(async () => {
        throw new SlackApiError("msg_blocks_too_long");
      })
      .mockImplementationOnce(async () => ({
        ok: true,
        ts: "1700000000.000300",
      }));

    const result = await sendSlackReply("C123", "Fresh reply", {
      threadTs,
      blocks,
    });

    expect(result).toEqual({ ok: true, ts: "1700000000.000300" });
    expect(callSlackApiMock).toHaveBeenCalledTimes(2);
    expect(callSlackApiMock).toHaveBeenNthCalledWith(2, "chat.postMessage", {
      channel: "C123",
      text: "Fresh reply",
      thread_ts: threadTs,
    });
  });

  test("does not drop blocks on a non-payload error", async () => {
    // Errors unrelated to the Block Kit payload (here `channel_not_found`) must
    // propagate, not trigger a wasteful block-free retry.
    callSlackApiMock.mockImplementationOnce(async () => {
      throw new SlackApiError("channel_not_found");
    });

    await expect(
      sendSlackReply("C123", "Fresh reply", { threadTs, blocks }),
    ).rejects.toThrow();
    expect(callSlackApiMock).toHaveBeenCalledTimes(1);
  });
});

describe("sendSlackReply approval fallback", () => {
  const approval = {
    requestId: "req-123",
    actions: [
      { id: "approve_once", label: "Approve once" },
      { id: "reject", label: "Reject" },
    ],
    plainTextFallback: 'Reply "ABC123 approve" or "ABC123 reject"',
  };
  const blocks: KnownBlock[] = [
    { type: "section", text: { type: "mrkdwn", text: "Approve tool: bash" } },
  ];

  beforeEach(() => {
    callSlackApiMock.mockReset();
    callSlackApiMock.mockImplementation(async () => ({ ok: true }));
  });

  test("block-free retry re-attaches plain-text reply instructions", async () => {
    // Dropping an approval's blocks drops its buttons — the retry text must
    // carry the reply instructions so the recipient can still act.
    callSlackApiMock
      .mockImplementationOnce(async () => {
        throw new SlackApiError("invalid_blocks");
      })
      .mockImplementationOnce(async () => ({
        ok: true,
        ts: "1700000000.000400",
      }));

    const result = await sendSlackReply("C123", "Approve tool: bash", {
      blocks,
      approval,
    });

    expect(result).toEqual({ ok: true, ts: "1700000000.000400" });
    expect(callSlackApiMock).toHaveBeenCalledTimes(2);
    expect(callSlackApiMock).toHaveBeenNthCalledWith(2, "chat.postMessage", {
      channel: "C123",
      text: 'Approve tool: bash\n\nReply "ABC123 approve" or "ABC123 reject"',
    });
  });

  test("retry text is unchanged when it already contains the instructions", async () => {
    callSlackApiMock
      .mockImplementationOnce(async () => {
        throw new SlackApiError("msg_blocks_too_long");
      })
      .mockImplementationOnce(async () => ({
        ok: true,
        ts: "1700000000.000500",
      }));

    const text = `Approve tool: bash\n\n${approval.plainTextFallback}`;
    await sendSlackReply("C123", text, { blocks, approval });

    expect(callSlackApiMock).toHaveBeenNthCalledWith(2, "chat.postMessage", {
      channel: "C123",
      text,
    });
  });

  test("approval without usable instructions is never retried bare", async () => {
    // A block-free approval with no reply instructions gives the recipient no
    // way to respond — fail the delivery instead so it surfaces as an error.
    callSlackApiMock.mockImplementationOnce(async () => {
      throw new SlackApiError("invalid_blocks");
    });

    await expect(
      sendSlackReply("C123", "Approve tool: bash", {
        blocks,
        approval: { ...approval, plainTextFallback: "  " },
      }),
    ).rejects.toThrow();
    expect(callSlackApiMock).toHaveBeenCalledTimes(1);
  });
});
