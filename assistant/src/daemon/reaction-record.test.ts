import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { QueuedReactionRecord } from "./reaction-record.js";

let persisted: Array<{
  conversationId: string;
  role: string;
  content: string;
  metadata: Record<string, unknown> | undefined;
}> = [];
let failNext = false;
const actualCrud = await import("../persistence/conversation-crud.js");
mock.module("../persistence/conversation-crud.js", () => ({
  ...actualCrud,
  addMessage: async (
    conversationId: string,
    role: string,
    content: string,
    opts?: { metadata?: Record<string, unknown> },
  ) => {
    if (failNext) {
      failNext = false;
      throw new Error("db closed");
    }
    persisted.push({ conversationId, role, content, metadata: opts?.metadata });
    return { id: `row-${persisted.length}` };
  },
}));

const { persistReactionRecords } = await import("./reaction-record.js");
const { drainQueuedReactionRecords } =
  await import("./conversation-agent-loop.js");

function record(
  overrides: Partial<QueuedReactionRecord> = {},
): QueuedReactionRecord {
  return {
    channel: "discord",
    chatId: "chan-1",
    messageId: "555.1",
    emoji: "🎉",
    op: "added",
    provenanceTrustClass: "guardian",
    ...overrides,
  };
}

describe("persistReactionRecords", () => {
  beforeEach(() => {
    persisted = [];
    failNext = false;
  });

  test("a neutral-channel record writes the providerMeta envelope", async () => {
    await persistReactionRecords("conv-1", [record()]);
    expect(persisted).toHaveLength(1);
    const row = persisted[0]!;
    expect(row.role).toBe("assistant");
    expect(row.content).toBe("[reaction]");
    expect(row.metadata?.messageKind).toBe("reaction");
    expect(row.metadata?.provenanceTrustClass).toBe("guardian");
    expect(row.metadata?.provenanceSourceChannel).toBe("discord");
    const envelope = JSON.parse(String(row.metadata?.providerMeta)) as {
      source: string;
      eventKind: string;
      reaction: { targetMessageId: string; emoji: string; op: string };
    };
    expect(envelope.source).toBe("discord");
    expect(envelope.eventKind).toBe("reaction");
    expect(envelope.reaction).toEqual({
      targetMessageId: "555.1",
      emoji: "🎉",
      op: "added",
    });
    expect(row.metadata?.slackMeta).toBeUndefined();
  });

  test("a Slack record writes the slackMeta envelope the Slack context reads", async () => {
    await persistReactionRecords("conv-1", [
      record({ channel: "slack", chatId: "C1", messageId: "1700.1" }),
    ]);
    const row = persisted[0]!;
    expect(row.metadata?.providerMeta).toBeUndefined();
    const slackMeta = JSON.parse(String(row.metadata?.slackMeta)) as {
      source: string;
      channelId: string;
      channelTs: string;
      eventKind: string;
      reaction: { emoji: string; targetChannelTs: string; op: string };
    };
    expect(slackMeta.source).toBe("slack");
    expect(slackMeta.channelId).toBe("C1");
    expect(slackMeta.channelTs).toBe("1700.1");
    expect(slackMeta.eventKind).toBe("reaction");
    expect(slackMeta.reaction).toEqual({
      emoji: "🎉",
      targetChannelTs: "1700.1",
      op: "added",
    });
  });

  test("the terminal drain persists queued records, clears the queue, and stale-marks", async () => {
    // The drain runs in the agent loop's finally, so an error exit still
    // reaches it: a delivered reaction's record must not depend on the turn
    // finishing cleanly.
    let staleMarked = 0;
    const ctx = {
      conversationId: "conv-1",
      pendingReactionRecords: [record(), record({ emoji: "👍" })],
      markHistoryStale: () => {
        staleMarked += 1;
      },
    };
    await drainQueuedReactionRecords(ctx);
    expect(persisted).toHaveLength(2);
    expect(ctx.pendingReactionRecords).toHaveLength(0);
    expect(staleMarked).toBe(1);
  });

  test("the terminal drain is a no-op on an empty queue", async () => {
    let staleMarked = 0;
    await drainQueuedReactionRecords({
      conversationId: "conv-1",
      pendingReactionRecords: [],
      markHistoryStale: () => {
        staleMarked += 1;
      },
    });
    expect(persisted).toHaveLength(0);
    expect(staleMarked).toBe(0);
  });

  test("a failed write is logged, not thrown, and later records still persist", async () => {
    failNext = true;
    await persistReactionRecords("conv-1", [record(), record({ emoji: "👍" })]);
    expect(persisted).toHaveLength(1);
    const envelope = JSON.parse(
      String(persisted[0]?.metadata?.providerMeta),
    ) as { reaction: { emoji: string } };
    expect(envelope.reaction.emoji).toBe("👍");
  });
});
