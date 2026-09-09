import { beforeEach, describe, expect, mock, test } from "bun:test";

import { readSlackMetadataFromMessageMetadata } from "../messaging/providers/slack/message-metadata.js";
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

  test("a Slack record writes the neutral envelope, which the Slack context reads through its Slack view", async () => {
    await persistReactionRecords("conv-1", [
      record({ channel: "slack", chatId: "C1", messageId: "1700.1" }),
    ]);
    const row = persisted[0]!;
    expect(row.metadata?.slackMeta).toBeUndefined();
    const envelope = JSON.parse(String(row.metadata?.providerMeta)) as {
      source: string;
      conversationExternalId: string;
      eventKind: string;
      reaction: { targetMessageId: string; emoji: string; op: string };
    };
    expect(envelope.source).toBe("slack");
    expect(envelope.conversationExternalId).toBe("C1");
    expect(envelope.eventKind).toBe("reaction");
    expect(envelope.reaction).toEqual({
      targetMessageId: "1700.1",
      emoji: "🎉",
      op: "added",
    });
    // The Slack transcript's view of the same row: the reacted message's ts
    // stands in as `channelTs`, as the Slack envelope stores it.
    const view = readSlackMetadataFromMessageMetadata(
      JSON.stringify(row.metadata),
    );
    expect(view?.channelId).toBe("C1");
    expect(view?.channelTs).toBe("1700.1");
    expect(view?.eventKind).toBe("reaction");
    expect(view?.reaction).toEqual({
      emoji: "🎉",
      targetChannelTs: "1700.1",
      op: "added",
    });
  });

  test("the terminal drain persists the turn's owned records and stale-marks", async () => {
    // The drain runs in the agent loop's finally, so an error exit still
    // reaches it: a delivered reaction's record must not depend on the turn
    // finishing cleanly.
    let staleMarked = 0;
    const owned = [record(), record({ emoji: "👍" })];
    await drainQueuedReactionRecords(
      {
        conversationId: "conv-1",
        markHistoryStale: () => {
          staleMarked += 1;
        },
      },
      owned,
    );
    expect(persisted).toHaveLength(2);
    expect(owned).toHaveLength(0);
    expect(staleMarked).toBe(1);
  });

  test("one turn's drain never consumes a following turn's live queue", async () => {
    // Ownership is captured at release, while the turn is still exclusive;
    // the drain takes only that captured array. A record a following turn
    // queued on the conversation's live field stays untouched until that
    // turn's own boundary, so its row cannot land before its tool_result.
    const followingTurnQueue = [record({ emoji: "🆕" })];
    const ctx = {
      conversationId: "conv-1",
      pendingReactionRecords: followingTurnQueue,
      markHistoryStale: () => {},
    };
    await drainQueuedReactionRecords(ctx, []);
    expect(persisted).toHaveLength(0);
    expect(followingTurnQueue).toHaveLength(1);
  });

  test("the terminal drain is a no-op on an empty or absent owned set", async () => {
    let staleMarked = 0;
    await drainQueuedReactionRecords(
      {
        conversationId: "conv-1",
        markHistoryStale: () => {
          staleMarked += 1;
        },
      },
      undefined,
    );
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
