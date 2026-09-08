import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { KnownBlock } from "@slack/types";

// Derive the mock signature from the real export so it cannot drift from the
// production response shape (`SlackApiResponse`). A hand-rolled
// `Promise<Record<string, unknown>>` here would let a test pass against a
// response shape production never actually returns.
type CallSlackApi = typeof import("./api.js").callSlackApi;

const callSlackApiMock = mock<CallSlackApi>(async () => ({ ok: true }));

// Spread the real module so a factory listing only what today's tests touch
// cannot break the next import send.ts adds; the stubs below then override
// exactly the calls this suite asserts on.
const actualSlackApi = await import("./api.js");

mock.module("./api.js", () => ({
  ...actualSlackApi,
  callSlackApi: (method: string, body: Record<string, unknown>) =>
    callSlackApiMock(method, body),
  callSlackApiForm: async () => ({}),
  completeSlackUpload: async () => {},
  uploadToSlackUrl: async () => {},
  startSlackStream: (params: { markdownText?: string }) =>
    callSlackApiMock("chat.startStream", { ...params }),
  appendSlackStream: (params: { markdownText?: string }) =>
    callSlackApiMock("chat.appendStream", { ...params }),
  stopSlackStream: (params: { markdownText?: string }) =>
    callSlackApiMock("chat.stopStream", { ...params }),
}));

// The real error class: send.ts branches on `instanceof SlackApiError` from
// the (unmocked) shared transport, so thrown test errors must be real
// instances or every branch under test would silently take the generic path.
const { SlackApiError } = await import("./web-api-transport.js");
const {
  sendSlackAgentSessionStatus,
  sendSlackReaction,
  sendSlackReply,
  sendSlackStreamOp,
  updateSlackMessage,
} = await import("./send.js");
const { SLACK_STREAM_MARKDOWN_LIMIT } = await import("./api.js");

describe("sendSlackAgentSessionStatus", () => {
  const threadTs = "1700000000.000100";

  beforeEach(() => {
    callSlackApiMock.mockReset();
    callSlackApiMock.mockImplementation(async () => ({ ok: true }));
  });

  // Every phase, so a mapping that loses one fails here rather than showing
  // the wrong thing in Slack. `suspended` is the one with teeth: an approval
  // is waiting on a person, and Slack renders that differently from a turn
  // that is still running.
  test.each([
    ["idle", "active"],
    ["thinking", "processing"],
    ["streaming", "processing"],
    ["tool_running", "processing"],
    ["awaiting_confirmation", "suspended"],
  ] as const)("sends %s as the %s session status", async (phase, status) => {
    await sendSlackAgentSessionStatus({ channel: "C123", phase, threadTs });

    expect(callSlackApiMock).toHaveBeenCalledTimes(1);
    expect(callSlackApiMock).toHaveBeenCalledWith("agents.sessions.setStatus", {
      channel_id: "C123",
      status,
      thread_ts: threadTs,
    });
  });

  test("carries the initiator, which Slack reads only when it opens the session", async () => {
    await sendSlackAgentSessionStatus({
      channel: "C123",
      phase: "thinking",
      threadTs,
      initiatorUserId: "U0READER",
    });

    expect(callSlackApiMock).toHaveBeenCalledWith("agents.sessions.setStatus", {
      channel_id: "C123",
      status: "processing",
      thread_ts: threadTs,
      initiator_user_id: "U0READER",
    });
  });

  test("omits thread_ts in a conversation the app has not threaded", async () => {
    await sendSlackAgentSessionStatus({ channel: "D123", phase: "thinking" });

    expect(callSlackApiMock).toHaveBeenCalledWith("agents.sessions.setStatus", {
      channel_id: "D123",
      status: "processing",
    });
  });

  test("falls back to adding a reaction when the status call fails", async () => {
    callSlackApiMock
      .mockImplementationOnce(async () => {
        throw new Error("missing_scope");
      })
      .mockImplementationOnce(async () => ({ ok: true }));

    await sendSlackAgentSessionStatus({
      channel: "C123",
      phase: "thinking",
      threadTs,
    });

    expect(callSlackApiMock).toHaveBeenCalledTimes(2);
    expect(callSlackApiMock).toHaveBeenNthCalledWith(2, "reactions.add", {
      channel: "C123",
      name: "eyes",
      timestamp: threadTs,
    });
  });

  test("falls back to removing the reaction once the turn is no longer running", async () => {
    callSlackApiMock
      .mockImplementationOnce(async () => {
        throw new Error("missing_scope");
      })
      .mockImplementationOnce(async () => ({ ok: true }));

    await sendSlackAgentSessionStatus({
      channel: "C123",
      phase: "idle",
      threadTs,
    });

    expect(callSlackApiMock).toHaveBeenNthCalledWith(2, "reactions.remove", {
      channel: "C123",
      name: "eyes",
      timestamp: threadTs,
    });
  });

  test("stays quiet when the status fails and there is nothing to react to", async () => {
    callSlackApiMock.mockImplementationOnce(async () => {
      throw new Error("missing_scope");
    });

    await sendSlackAgentSessionStatus({ channel: "D123", phase: "thinking" });

    expect(callSlackApiMock).toHaveBeenCalledTimes(1);
  });
});

describe("sendSlackReaction", () => {
  test("adds with the bare emoji name, colons stripped", async () => {
    const result = await sendSlackReaction("C1", ":tada:", "123.456", "add");
    expect(result).toEqual({ ok: true });
    expect(callSlackApiMock).toHaveBeenCalledWith("reactions.add", {
      channel: "C1",
      name: "tada",
      timestamp: "123.456",
    });
  });

  test("remove routes to reactions.remove", async () => {
    await sendSlackReaction("C1", "tada", "123.456", "remove");
    expect(callSlackApiMock).toHaveBeenCalledWith("reactions.remove", {
      channel: "C1",
      name: "tada",
      timestamp: "123.456",
    });
  });

  test("already_reacted reads as success: the end state holds", async () => {
    callSlackApiMock.mockImplementationOnce(async () => {
      throw new SlackApiError("already_reacted");
    });
    const result = await sendSlackReaction("C1", "tada", "123.456", "add");
    expect(result).toEqual({ ok: true });
  });

  test("any other failure reports ok false without throwing", async () => {
    callSlackApiMock.mockImplementationOnce(async () => {
      throw new SlackApiError("channel_not_found");
    });
    const result = await sendSlackReaction("C1", "tada", "123.456", "add");
    expect(result).toEqual({ ok: false });
  });
});

describe("updateSlackMessage", () => {
  const messageTs = "1700000000.000100";
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

    const result = await updateSlackMessage("C123", messageTs, "Final reply", {
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
      updateSlackMessage("C123", messageTs, "Final reply", { blocks }),
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
      updateSlackMessage("C123", messageTs, "Final reply", { blocks }),
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
      updateSlackMessage("C123", messageTs, "Final reply", { blocks }),
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

describe("sendSlackStreamOp", () => {
  const streamTs = "1700000000.000900";

  beforeEach(() => {
    callSlackApiMock.mockReset();
    callSlackApiMock.mockImplementation(async () => ({ ok: true }));
  });

  test("sends one call per operation, whatever the caller hands over", async () => {
    // Splitting to fit the cap belongs to the caller, which is what tracks how
    // much of the reply Slack has taken. This layer performs the operation it
    // is given, once.
    const appended = "x".repeat(SLACK_STREAM_MARKDOWN_LIMIT);
    await sendSlackStreamOp("C-STREAM", {
      action: "append",
      streamId: streamTs,
      text: appended,
      appended,
    });

    const calls = callSlackApiMock.mock.calls.filter(
      (call) => call[0] === "chat.appendStream",
    );
    expect(calls).toHaveLength(1);
    expect((calls[0]![1] as { markdownText?: string }).markdownText).toBe(
      appended,
    );
  });

  test("a plan that moved with no new words still reaches the message", async () => {
    // `chat.appendStream` documents "One of markdown_text or chunks is
    // required", so a plan-only call is legal and is what ticks the plan block
    // during silent work.
    await sendSlackStreamOp("C-STREAM", {
      action: "append",
      streamId: streamTs,
      text: "unchanged",
      plan: { steps: [{ label: "Step", status: "completed" }] },
    });

    const calls = callSlackApiMock.mock.calls.filter(
      (call) => call[0] === "chat.appendStream",
    );
    expect(calls).toHaveLength(1);
    const body = calls[0]![1] as { markdownText?: string; tasks?: unknown };
    expect(body.markdownText).toBeUndefined();
    expect(body.tasks).toBeDefined();
  });
});
