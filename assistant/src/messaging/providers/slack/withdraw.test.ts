import { beforeEach, describe, expect, mock, test } from "bun:test";

const getSlackMessageBlocks = mock(
  async (_channel: string, _ts: string): Promise<unknown[] | null> => null,
);
const callSlackApi = mock(
  async (_method: string, _body: Record<string, unknown>) => ({
    ok: true,
    ts: "1.0",
  }),
);
mock.module("./api.js", () => ({ getSlackMessageBlocks, callSlackApi }));

import {
  stripApprovalActionBlocks,
  withdrawSlackApprovalCard,
} from "./withdraw.js";

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
    callSlackApi.mockReset();
    callSlackApi.mockImplementation(async () => ({ ok: true, ts: "1.0" }));
  });

  test("edits in place, preserving content, removing buttons, appending status", async () => {
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

    expect(callSlackApi).toHaveBeenCalledTimes(1);
    const [method, body] = callSlackApi.mock.calls[0];
    expect(method).toBe("chat.update");
    expect(body.channel).toBe("C1");
    expect(body.ts).toBe("1700000000.0001");

    const blocks = body.blocks as Array<Record<string, unknown>>;
    // original card (no actions) + original context + appended status context
    expect(blocks).toHaveLength(3);
    expect(blocks[0].type).toBe("card");
    expect("actions" in blocks[0]).toBe(false);
    expect(JSON.stringify(blocks)).not.toContain("apr:");

    // status line carries the outcome, decider mention, and a date token
    const statusText = JSON.stringify(blocks[2]);
    expect(statusText).toContain("Approved");
    expect(statusText).toContain("<@U-guardian>");
    expect(statusText).toContain("<!date^1700000000^");
  });

  test("falls back to a status-only edit when the original blocks can't be read", async () => {
    getSlackMessageBlocks.mockImplementationOnce(async () => null);

    await withdrawSlackApprovalCard({
      channel: "C1",
      messageTs: "1.0",
      status: "denied",
    });

    expect(callSlackApi).toHaveBeenCalledTimes(1);
    const [method, body] = callSlackApi.mock.calls[0];
    expect(method).toBe("chat.update");
    const blocks = body.blocks as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("section");
    expect(JSON.stringify(blocks)).toContain("Denied");
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

    expect(callSlackApi).toHaveBeenCalledTimes(1);
    expect(callSlackApi.mock.calls[0][0]).toBe("chat.update");
  });

  test("retries with a status-only edit when preserved blocks are rejected", async () => {
    getSlackMessageBlocks.mockImplementationOnce(async () => [
      {
        type: "card",
        body: { type: "mrkdwn", text: "Alice wants in" },
        actions: [{ type: "button", action_id: "apr:r1:approve_once" }],
      },
    ]);
    // First chat.update (preserved blocks) is rejected; second must still edit.
    callSlackApi.mockImplementationOnce(async () => {
      throw new Error("invalid_blocks");
    });

    await withdrawSlackApprovalCard({
      channel: "C1",
      messageTs: "1.0",
      status: "approved",
    });

    expect(callSlackApi).toHaveBeenCalledTimes(2);
    // both attempts are edits — never a new message
    expect(callSlackApi.mock.calls.every((c) => c[0] === "chat.update")).toBe(
      true,
    );
    const retryBlocks = callSlackApi.mock.calls[1][1].blocks as Array<
      Record<string, unknown>
    >;
    expect(retryBlocks).toHaveLength(1);
    expect(retryBlocks[0].type).toBe("section");
  });

  test("never posts a new message (withdrawal is edit-only)", async () => {
    getSlackMessageBlocks.mockImplementationOnce(async () => null);
    await withdrawSlackApprovalCard({
      channel: "C1",
      messageTs: "1.0",
      status: "approved",
    });
    expect(
      callSlackApi.mock.calls.some((c) => c[0] === "chat.postMessage"),
    ).toBe(false);
  });
});
