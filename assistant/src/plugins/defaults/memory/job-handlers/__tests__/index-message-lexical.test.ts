import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

import type { SparseEmbedding } from "../../../../../persistence/embeddings/embedding-types.js";

mock.module("../../../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Capture calls into the lexical index singleton.
const upsertCalls: Array<{
  messageId: string;
  sparse: SparseEmbedding;
  payload: { conversationId: string; createdAt: number };
}> = [];
const deleteByConversationCalls: string[] = [];

const fakeIndex = {
  upsertMessage: async (
    messageId: string,
    sparse: SparseEmbedding,
    payload: { conversationId: string; createdAt: number },
  ) => {
    upsertCalls.push({ messageId, sparse, payload });
  },
  deleteByConversation: async (conversationId: string) => {
    deleteByConversationCalls.push(conversationId);
  },
};

mock.module(
  "../../../../../persistence/embeddings/messages-lexical-index.js",
  () => ({
    getMessagesLexicalIndex: () => fakeIndex,
  }),
);

// `generateSparseEmbedding` is a pure local TF-IDF encoder (no provider call),
// so it runs unmocked — mocking `embedding-backend.js` wholesale would starve
// its other named exports that the db-init import graph pulls in.
import { resetDbForTesting } from "../../../../../__tests__/db-test-helpers.js";
import { DEFAULT_CONFIG } from "../../../../../config/defaults.js";
import type { AssistantConfig } from "../../../../../config/types.js";
import { getDb } from "../../../../../persistence/db-connection.js";
import { initializeDb } from "../../../../../persistence/db-init.js";
import { generateSparseEmbedding } from "../../../../../persistence/embeddings/embedding-backend.js";
import type { MemoryJob } from "../../../../../persistence/jobs-store.js";
import {
  conversations,
  messages,
} from "../../../../../persistence/schema/index.js";
import {
  indexMessageLexicalJob,
  purgeConversationLexicalJob,
} from "../index-message-lexical.js";

const TEST_CONFIG: AssistantConfig = DEFAULT_CONFIG;

function makeJob(
  type: MemoryJob["type"],
  payload: Record<string, unknown>,
): MemoryJob {
  return {
    id: "job-1",
    type,
    payload,
    status: "running",
    attempts: 0,
    deferrals: 0,
    runAfter: 0,
    lastError: null,
    startedAt: Date.now(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function insertConversation(id: string): void {
  const now = Date.now();
  getDb()
    .insert(conversations)
    .values({ id, createdAt: now, updatedAt: now })
    .run();
}

function insertMessage(opts: {
  id: string;
  conversationId: string;
  content: string;
  createdAt: number;
}): void {
  getDb()
    .insert(messages)
    .values({
      id: opts.id,
      conversationId: opts.conversationId,
      role: "user",
      content: opts.content,
      createdAt: opts.createdAt,
    })
    .run();
}

describe("indexMessageLexicalJob", () => {
  // initializeDb runs the full migration chain; under parallel CI load it can
  // exceed bun's default 5s hook timeout, so allow more.
  beforeAll(async () => {
    await initializeDb();
  }, 30_000);

  beforeEach(async () => {
    upsertCalls.length = 0;
    deleteByConversationCalls.length = 0;
    resetDbForTesting();
    await initializeDb();
  }, 30_000);

  test("loads the message and upserts it into the lexical index", async () => {
    const createdAt = 1_700_000_000_000;
    const content = "hello lexical world";
    insertConversation("conv-1");
    insertMessage({
      id: "msg-1",
      conversationId: "conv-1",
      content,
      createdAt,
    });

    await indexMessageLexicalJob(
      makeJob("index_message_lexical", { messageId: "msg-1" }),
      TEST_CONFIG,
    );

    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0].messageId).toBe("msg-1");
    // The handler encodes the message content via the local sparse encoder.
    expect(upsertCalls[0].sparse).toEqual(generateSparseEmbedding(content));
    expect(upsertCalls[0].payload).toEqual({
      conversationId: "conv-1",
      createdAt,
    });
  });

  test("no-ops when messageId is missing from the payload", async () => {
    await indexMessageLexicalJob(
      makeJob("index_message_lexical", {}),
      TEST_CONFIG,
    );
    expect(upsertCalls).toHaveLength(0);
  });

  test("no-ops when the message no longer exists", async () => {
    await indexMessageLexicalJob(
      makeJob("index_message_lexical", { messageId: "nonexistent" }),
      TEST_CONFIG,
    );
    expect(upsertCalls).toHaveLength(0);
  });
});

describe("purgeConversationLexicalJob", () => {
  beforeAll(async () => {
    await initializeDb();
  }, 30_000);

  beforeEach(async () => {
    upsertCalls.length = 0;
    deleteByConversationCalls.length = 0;
    resetDbForTesting();
    await initializeDb();
  }, 30_000);

  test("deletes the conversation's points from the lexical index", async () => {
    await purgeConversationLexicalJob(
      makeJob("purge_conversation_lexical", { conversationId: "conv-9" }),
      TEST_CONFIG,
    );
    expect(deleteByConversationCalls).toEqual(["conv-9"]);
  });

  test("no-ops when conversationId is missing from the payload", async () => {
    await purgeConversationLexicalJob(
      makeJob("purge_conversation_lexical", {}),
      TEST_CONFIG,
    );
    expect(deleteByConversationCalls).toHaveLength(0);
  });
});
