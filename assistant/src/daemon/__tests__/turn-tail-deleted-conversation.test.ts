/**
 * `runDeferredTurnTail` runs after the terminal SSE, so the user can delete the
 * conversation while its awaited bookkeeping is still draining. These tests pin
 * that the tail's two filesystem steps (tool-result spooling and the JSONL disk
 * mirror) read the conversation fresh and skip once it is gone, rather than
 * rebuilding a deleted conversation's directory from in-memory history.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { makeMockLogger } from "../../__tests__/helpers/mock-logger.js";
import { setConfig } from "../../__tests__/helpers/set-config.js";
import type { ConversationRow } from "../../persistence/conversation-crud.js";
import type { Message } from "../../providers/types.js";
import type { InflightContentWriter } from "../inflight-message-content.js";

// The finalize module's import graph reaches the memory indexer; keep it inert
// so no embedding backend is touched.
setConfig("memory", { enabled: false, v2: { enabled: false } });

const CONVERSATION_ID = "conv-tail-delete-1";
const ASSISTANT_MESSAGE_ID = "msg-assistant-1";
const USER_MESSAGE_ID = "msg-user-1";
const CONVERSATION_DIR = "/tmp/vellum-test/conv-tail-delete-1";

/** Flipped by a deferred finalize effect to model a mid-tail deletion. */
let conversationDeleted = false;
let getConversationCalls = 0;
const resolvedDirCalls: string[] = [];
const truncateCalls: string[] = [];
const diskSyncCalls: string[] = [];

const TRUNCATED_MESSAGES: Message[] = [{ role: "user", content: [] }];

mock.module("../../notifications/assistant-reply-producer.js", () => ({
  emitAssistantReplyNotification: (): Promise<void> => Promise.resolve(),
}));

function makeConversation(): ConversationRow {
  return {
    id: CONVERSATION_ID,
    title: null,
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalEstimatedCost: 0,
    contextSummary: null,
    contextCompactedMessageCount: 0,
    contextCompactedAt: null,
    historyStrippedAt: null,
    slackContextCompactionWatermarkTs: null,
    slackContextCompactionWatermarkAt: null,
    conversationType: "chat",
    source: "user",
    originChannel: null,
    originInterface: null,
    forkParentConversationId: null,
    forkParentMessageId: null,
    isAutoTitle: 0,
    scheduleJobId: null,
    lastMessageAt: null,
    archivedAt: null,
    surfacedAt: null,
    inferenceProfile: null,
    enabledPlugins: null,
    inferenceProfileSessionId: null,
    inferenceProfileExpiresAt: null,
    lastNotifiedInferenceProfile: null,
    processingStartedAt: null,
  };
}

const realCrud = await import("../../persistence/conversation-crud.js");
mock.module("../../persistence/conversation-crud.js", () => ({
  ...realCrud,
  getConversation: (): ConversationRow | null => {
    getConversationCalls += 1;
    return conversationDeleted ? null : makeConversation();
  },
}));

const realDirectories =
  await import("../../persistence/conversation-directories.js");
mock.module("../../persistence/conversation-directories.js", () => ({
  ...realDirectories,
  getResolvedConversationDirPath: (id: string): string => {
    resolvedDirCalls.push(id);
    return CONVERSATION_DIR;
  },
}));

const realTruncation =
  await import("../../context/post-turn-tool-result-truncation.js");
mock.module("../../context/post-turn-tool-result-truncation.js", () => ({
  ...realTruncation,
  derefToolResultReReads: (messages: Message[]) => ({
    messages,
    dereferencedCount: 0,
  }),
  postTurnTruncateToolResults: (
    _messages: Message[],
    options: { conversationDir: string },
  ) => {
    truncateCalls.push(options.conversationDir);
    return { messages: TRUNCATED_MESSAGES, truncatedCount: 0 };
  },
}));

const realDiskView =
  await import("../../persistence/conversation-disk-view.js");
mock.module("../../persistence/conversation-disk-view.js", () => ({
  ...realDiskView,
  syncMessageToDisk: (_conversationId: string, messageId: string): void => {
    diskSyncCalls.push(messageId);
  },
}));

const { runDeferredTurnTail } =
  await import("../conversation-turn-finalize.js");

const rlog = makeMockLogger() as Parameters<
  typeof runDeferredTurnTail
>[0]["rlog"];

/** Runs the tail with one deferred effect standing in for the turn's bookkeeping. */
async function runTail(
  deferredEffect: () => Promise<void>,
): Promise<Message[]> {
  const ctx = { conversationId: CONVERSATION_ID, messages: [] as Message[] };
  await runDeferredTurnTail({
    ctx,
    state: {
      deferredFinalizeEffects: [deferredEffect],
      lastAssistantMessageId: ASSISTANT_MESSAGE_ID,
      inflightWriters: new Map<string, InflightContentWriter>(),
    },
    rlog,
    generationCompletedAt: Date.now(),
    turnCompleted: true,
    userMessageId: USER_MESSAGE_ID,
  });
  return ctx.messages;
}

beforeEach(() => {
  conversationDeleted = false;
  getConversationCalls = 0;
  resolvedDirCalls.length = 0;
  truncateCalls.length = 0;
  diskSyncCalls.length = 0;
});

describe("runDeferredTurnTail conversation deleted mid-tail", () => {
  test("skips the filesystem steps when the conversation is gone", async () => {
    const messages = await runTail(async () => {
      conversationDeleted = true;
    });

    expect(resolvedDirCalls).toEqual([]);
    expect(truncateCalls).toEqual([]);
    expect(diskSyncCalls).toEqual([]);
    expect(messages).toEqual([]);
  });

  test("reads the conversation once more before the filesystem steps", async () => {
    await runTail(async () => {
      conversationDeleted = true;
    });

    expect(getConversationCalls).toBe(2);
  });

  test("runs the filesystem steps when the conversation survives", async () => {
    const messages = await runTail(async () => {});

    expect(resolvedDirCalls).toEqual([CONVERSATION_ID]);
    expect(truncateCalls).toEqual([CONVERSATION_DIR]);
    expect(diskSyncCalls).toEqual([ASSISTANT_MESSAGE_ID]);
    expect(messages).toEqual(TRUNCATED_MESSAGES);
  });
});
