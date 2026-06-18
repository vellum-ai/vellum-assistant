import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
  truncateForLog: (value: string) => value,
}));

const getSlackMessageBlocks = mock(
  async (_channel: string, _ts: string): Promise<unknown[] | null> => null,
);
mock.module("../api.js", () => ({ getSlackMessageBlocks }));

const sendSlackReply = mock(
  async (
    _chatId: string,
    _text: string,
    _options?: Record<string, unknown>,
  ) => ({ ts: "1.0" }),
);
mock.module("../send.js", () => ({ sendSlackReply }));

import {
  stripApprovalActionBlocks,
  withdrawSlackApprovalCard,
} from "../withdraw.js";

describe("stripApprovalActionBlocks", () => {
  test("strips the actions array from a native card block, keeping content", () => {
    const blocks = [
      {
        type: "card",
        title: { type: "plain_text", text: "Access Request" },
        body: { type: "mrkdwn", text: "Alice wants in" },
        actions: [{ type: "button", action_id: "apr:r1:approve_once" }],
      },
    ];
    const result = stripApprovalActionBlocks(blocks) as Array<
      Record<string, unknown>
    >;
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("card");
    expect(result[0].title).toEqual({
      type: "plain_text",
      text: "Access Request",
    });
    expect(result[0].body).toEqual({ type: "mrkdwn", text: "Alice wants in" });
    expect("actions" in result[0]).toBe(false);
  });

  test("drops standalone actions blocks and preserves everything else", () => {
    const blocks = [
      { type: "section", text: { type: "mrkdwn", text: "Context" } },
      {
        type: "actions",
        elements: [{ type: "button", action_id: "apr:r1:reject" }],
      },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: "Source: Slack" }],
      },
    ];
    const result = stripApprovalActionBlocks(blocks) as Array<
      Record<string, unknown>
    >;
    expect(result.map((b) => b.type)).toEqual(["section", "context"]);
  });

  test("tolerates non-object entries", () => {
    const result = stripApprovalActionBlocks([
      null,
      "weird",
      { type: "section" },
    ]);
    expect(result).toHaveLength(3);
  });
});

describe("withdrawSlackApprovalCard", () => {
  beforeEach(() => {
    getSlackMessageBlocks.mockReset();
    sendSlackReply.mockReset();
    sendSlackReply.mockImplementation(async () => ({ ts: "1.0" }));
  });

  test("preserves original content, removes buttons, appends a status line", async () => {
    getSlackMessageBlocks.mockImplementationOnce(async () => [
      {
        type: "card",
        title: { type: "plain_text", text: "Access Request" },
        body: { type: "mrkdwn", text: "Alice wants in" },
        actions: [{ type: "button", action_id: "apr:r1:approve_once" }],
      },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: "Source: Slack" }],
      },
    ]);

    await withdrawSlackApprovalCard({
      channel: "C1",
      messageTs: "1700000000.0001",
      status: "approved",
      decidedByExternalUserId: "U-guardian",
      decidedAtMs: 1_700_000_000_000,
    });

    expect(sendSlackReply).toHaveBeenCalledTimes(1);
    const [chatId, text, options] = sendSlackReply.mock.calls[0];
    expect(chatId).toBe("C1");
    expect(options?.messageTs).toBe("1700000000.0001");

    const blocks = options?.blocks as Array<Record<string, unknown>>;
    // original card (no actions) + original context + appended status context
    expect(blocks).toHaveLength(3);
    expect(blocks[0].type).toBe("card");
    expect("actions" in blocks[0]).toBe(false);
    expect(JSON.stringify(blocks)).not.toContain("apr:");

    // status line carries the outcome, decider mention, and a date token
    const statusBlock = blocks[2];
    const statusText = JSON.stringify(statusBlock);
    expect(statusText).toContain("Approved");
    expect(statusText).toContain("<@U-guardian>");
    expect(statusText).toContain("<!date^1700000000^");
    expect(text).toContain("Approved");
  });

  test("falls back to a status-only edit when the original blocks can't be read", async () => {
    getSlackMessageBlocks.mockImplementationOnce(async () => null);

    await withdrawSlackApprovalCard({
      channel: "C1",
      messageTs: "1.0",
      status: "denied",
    });

    const [, , options] = sendSlackReply.mock.calls[0];
    const blocks = options?.blocks as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("section");
    expect(JSON.stringify(blocks)).toContain("Denied");
    // still an in-place edit (buttons removed), not a new message
    expect(options?.messageTs).toBe("1.0");
  });

  test("falls back when the fetch throws (e.g. missing history scope)", async () => {
    getSlackMessageBlocks.mockImplementationOnce(async () => {
      throw new Error("missing_scope");
    });

    await withdrawSlackApprovalCard({
      channel: "C1",
      messageTs: "1.0",
      status: "approved",
    });

    expect(sendSlackReply).toHaveBeenCalledTimes(1);
    const [, , options] = sendSlackReply.mock.calls[0];
    expect((options?.blocks as unknown[]).length).toBe(1);
  });
});
