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

let persisted: Array<{
  conversationId: string;
  role: string;
  content: string;
  metadata: Record<string, unknown> | undefined;
}> = [];
const actualCrud = await import("../../persistence/conversation-crud.js");
mock.module("../../persistence/conversation-crud.js", () => ({
  ...actualCrud,
  addMessage: async (
    conversationId: string,
    role: string,
    content: string,
    opts?: { metadata?: Record<string, unknown> },
  ) => {
    persisted.push({ conversationId, role, content, metadata: opts?.metadata });
    return { id: `persisted-${persisted.length}` };
  },
}));

let staleMarked: string[] = [];
mock.module("../../daemon/conversation-registry.js", () => ({
  findConversation: (id: string) => ({
    markHistoryStale: () => staleMarked.push(id),
  }),
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
    persisted = [];
    staleMarked = [];
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

  test("a delivered reaction persists as a standalone reaction row", async () => {
    await reactToMessageTool.execute({ emoji: "thumbsup" }, channelContext());
    expect(persisted).toHaveLength(1);
    const row = persisted[0]!;
    expect(row.conversationId).toBe("conv-1");
    expect(row.role).toBe("assistant");
    expect(row.content).toBe("[reaction]");
    expect(row.metadata?.messageKind).toBe("reaction");
    expect(row.metadata?.provenanceTrustClass).toBe("guardian");
    expect(row.metadata?.provenanceSourceChannel).toBe("slack");
    const envelope = JSON.parse(String(row.metadata?.providerMeta)) as {
      source: string;
      eventKind: string;
      reaction: { targetMessageId: string; emoji: string; op: string };
    };
    expect(envelope.source).toBe("slack");
    expect(envelope.eventKind).toBe("reaction");
    expect(envelope.reaction).toEqual({
      targetMessageId: "1700000000.111111",
      emoji: "thumbsup",
      op: "added",
    });
    expect(staleMarked).toEqual(["conv-1"]);
  });

  test("a removed reaction persists op removed", async () => {
    await reactToMessageTool.execute(
      { emoji: "thumbsup", action: "remove" },
      channelContext(),
    );
    const envelope = JSON.parse(
      String(persisted[0]?.metadata?.providerMeta),
    ) as { reaction: { op: string } };
    expect(envelope.reaction.op).toBe("removed");
  });

  test("a rejected reaction persists nothing", async () => {
    reactResultOk = false;
    await reactToMessageTool.execute({ emoji: "thumbsup" }, channelContext());
    expect(persisted).toHaveLength(0);
    expect(staleMarked).toHaveLength(0);
  });

  test("rejects input with no emoji", async () => {
    const result = await reactToMessageTool.execute({}, channelContext());
    expect(result.isError).toBe(true);
    expect(reactCalls).toHaveLength(0);
  });
});
