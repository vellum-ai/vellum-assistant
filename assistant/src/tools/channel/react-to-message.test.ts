import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { ReactionTarget } from "../../messaging/providers/channel-transport.js";
import type { ToolContext } from "../types.js";

let reactCalls: Array<{ channel: string; target: ReactionTarget }> = [];
let reactResultOk = true;
let channelSupported = true;

mock.module("../../messaging/providers/index.js", () => ({
  supportsChannelReaction: () => channelSupported,
  sendChannelReaction: async (channel: string, target: ReactionTarget) => {
    reactCalls.push({ channel, target });
    return { ok: reactResultOk };
  },
}));

import type { QueuedReactionRecord } from "../../daemon/reaction-record.js";

let queued: Array<{ conversationId: string; record: QueuedReactionRecord }> =
  [];
let conversationResident = true;
mock.module("../../daemon/conversation-registry.js", () => ({
  findConversationOrSubagent: (id: string) =>
    conversationResident
      ? {
          queueReactionRecord: (record: QueuedReactionRecord) =>
            queued.push({ conversationId: id, record }),
        }
      : undefined,
}));

let directPersists: Array<{
  conversationId: string;
  records: readonly QueuedReactionRecord[];
}> = [];
mock.module("../../daemon/reaction-record.js", () => ({
  persistReactionRecords: async (
    conversationId: string,
    records: readonly QueuedReactionRecord[],
  ) => {
    directPersists.push({ conversationId, records });
  },
}));

const { reactToMessageTool } = await import("./react-to-message.js");

function channelContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workingDir: "/tmp",
    conversationId: "conv-1",
    trustClass: "guardian",
    executionChannel: "slack",
    requesterChatId: "C123",
    sourceMessageId: "1700000000.111111",
    ...overrides,
  } as ToolContext;
}

describe("react_to_message", () => {
  beforeEach(() => {
    reactCalls = [];
    reactResultOk = true;
    channelSupported = true;
    queued = [];
    directPersists = [];
    conversationResident = true;
  });

  test("reacts to the triggering message by default", async () => {
    const result = await reactToMessageTool.execute(
      { emoji: "thumbsup" },
      channelContext(),
    );
    expect(result.isError).toBe(false);
    expect(reactCalls).toHaveLength(1);
    expect(reactCalls[0]).toEqual({
      channel: "slack",
      target: {
        chatId: "C123",
        messageId: "1700000000.111111",
        emoji: "thumbsup",
        action: "add",
      },
    });
  });

  test("an explicit messageId overrides the default target", async () => {
    await reactToMessageTool.execute(
      { emoji: "tada", messageId: "1700000000.222222" },
      channelContext(),
    );
    expect(reactCalls[0]?.target.messageId).toBe("1700000000.222222");
  });

  test("the turn's thread coordinate rides only the default target", async () => {
    await reactToMessageTool.execute(
      { emoji: "tada" },
      channelContext({ sourceThreadId: "THREAD-1" }),
    );
    expect(reactCalls[0]?.target.threadId).toBe("THREAD-1");

    await reactToMessageTool.execute(
      { emoji: "tada", messageId: "other-msg" },
      channelContext({ sourceThreadId: "THREAD-1" }),
    );
    expect(reactCalls[1]?.target.threadId).toBeUndefined();
  });

  test("remove action passes through and reports removal", async () => {
    const result = await reactToMessageTool.execute(
      { emoji: "tada", action: "remove" },
      channelContext(),
    );
    expect(reactCalls[0]?.target.action).toBe("remove");
    expect(result.content).toContain("Removed");
  });

  test("errors without channel message context", async () => {
    const result = await reactToMessageTool.execute(
      { emoji: "thumbsup" },
      channelContext({ executionChannel: undefined }),
    );
    expect(result.isError).toBe(true);
    expect(reactCalls).toHaveLength(0);
  });

  test("errors on a channel without the capability", async () => {
    channelSupported = false;
    const result = await reactToMessageTool.execute(
      { emoji: "thumbsup" },
      channelContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("does not support reactions");
    expect(reactCalls).toHaveLength(0);
  });

  test("a channel rejection reaches the model as an error", async () => {
    reactResultOk = false;
    const result = await reactToMessageTool.execute(
      { emoji: "thumbsup" },
      channelContext(),
    );
    expect(result.isError).toBe(true);
  });

  test("a delivered reaction queues its durable record on the conversation", async () => {
    await reactToMessageTool.execute({ emoji: "thumbsup" }, channelContext());
    expect(queued).toHaveLength(1);
    expect(queued[0]).toEqual({
      conversationId: "conv-1",
      record: {
        channel: "slack",
        chatId: "C123",
        messageId: "1700000000.111111",
        emoji: "thumbsup",
        op: "added",
        provenanceTrustClass: "guardian",
      },
    });
    expect(directPersists).toHaveLength(0);
  });

  test("a removed reaction queues op removed", async () => {
    await reactToMessageTool.execute(
      { emoji: "thumbsup", action: "remove" },
      channelContext(),
    );
    expect(queued[0]?.record.op).toBe("removed");
  });

  test("with no resident conversation the record persists directly", async () => {
    conversationResident = false;
    await reactToMessageTool.execute({ emoji: "thumbsup" }, channelContext());
    expect(queued).toHaveLength(0);
    expect(directPersists).toHaveLength(1);
    expect(directPersists[0]?.records[0]?.emoji).toBe("thumbsup");
  });

  test("a rejected reaction records nothing", async () => {
    reactResultOk = false;
    await reactToMessageTool.execute({ emoji: "thumbsup" }, channelContext());
    expect(queued).toHaveLength(0);
    expect(directPersists).toHaveLength(0);
  });

  test("rejects input with no emoji", async () => {
    const result = await reactToMessageTool.execute({}, channelContext());
    expect(result.isError).toBe(true);
    expect(reactCalls).toHaveLength(0);
  });
});
