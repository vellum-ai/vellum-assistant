// Integration coverage for the messages lexical-index write wiring:
//   - a real persist (`addMessage`) enqueues one `index_message_lexical` job
//     for the message, regardless of whether memory is enabled or disabled
//     (message-content search is host infrastructure);
//   - forking a conversation copies message rows WITHOUT routing through
//     the persist path, so a fork enqueues ZERO `index_message_lexical`
//     jobs (the fork-exclusion regression);
//   - wiping a conversation enqueues one `purge_conversation_lexical` job.
//
// The heavy segment indexer (`indexMessageNow`) is stubbed to a no-op so these
// tests exercise only the lexical enqueue seam, not the embedding/extraction
// machinery. Memory config is real (default-enabled), flipped on disk for the
// disabled case.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";

import { eq } from "drizzle-orm";

import { makeMockLogger } from "./helpers/mock-logger.js";

mock.module("../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
}));

// Stub the segment indexer so `onMessagePersisted` runs cheaply. The lexical
// enqueue in the hook is a separate call and still fires. Other exports are
// provided so any transitive importer of this module resolves. `throwFromIndex`
// lets a test simulate a transient segment-indexing failure to prove the
// lexical enqueue survives it.
let throwFromIndex = false;
mock.module("../plugins/defaults/memory/indexer.js", () => ({
  MIN_SEGMENT_CHARS: 50,
  indexMessageNow: async () => {
    if (throwFromIndex) {
      throw new Error("simulated segment-indexing failure");
    }
    return { indexedSegments: 0, enqueuedJobs: 0 };
  },
  enqueueBackfillJob: () => "",
  enqueueRebuildIndexJob: () => "",
}));

import {
  invalidateConfigCache,
  loadRawConfig,
  saveRawConfig,
} from "../config/loader.js";
import { consolidateAssistantMessages } from "../daemon/conversation-history.js";
import {
  addMessage,
  createConversation,
  deleteConversation,
  deleteConversationGently,
  deleteLastExchange,
  deleteMessageById,
  forkConversation,
  getMessages,
  updateMessageContent,
} from "../persistence/conversation-crud.js";
import { getMemoryDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { enqueueLexicalIndexForMessage } from "../persistence/job-handlers/message-lexical.js";
import type { MemoryJobType } from "../persistence/jobs-store.js";
import { enqueueMemoryJob } from "../persistence/jobs-store.js";
import { memoryJobs } from "../persistence/schema/index.js";
import { memoryPersistenceHooks } from "../plugins/defaults/memory/persistence-hooks.js";

await initializeDb();

function countJobs(type: MemoryJobType, conversationId?: string): number {
  const rows = getMemoryDb()!
    .select({ payload: memoryJobs.payload })
    .from(memoryJobs)
    .where(eq(memoryJobs.type, type))
    .all();
  if (conversationId == null) {
    return rows.length;
  }
  return rows.filter((r) => {
    try {
      return (
        (JSON.parse(r.payload) as { conversationId?: string })
          .conversationId === conversationId
      );
    } catch {
      return false;
    }
  }).length;
}

function lexicalJobMessageIds(): string[] {
  return getMemoryDb()!
    .select({ payload: memoryJobs.payload })
    .from(memoryJobs)
    .where(eq(memoryJobs.type, "index_message_lexical"))
    .all()
    .map((r) => {
      try {
        return (
          (JSON.parse(r.payload) as { messageId?: string }).messageId ?? ""
        );
      } catch {
        return "";
      }
    });
}

function resetMemoryJobs(): void {
  getMemoryDb()!.delete(memoryJobs).run();
}

function setMemoryEnabled(enabled: boolean): void {
  const raw = loadRawConfig();
  const memory =
    raw.memory && typeof raw.memory === "object"
      ? (raw.memory as Record<string, unknown>)
      : {};
  saveRawConfig({ ...raw, memory: { ...memory, enabled } });
  invalidateConfigCache();
}

describe("messages lexical-index dual-write", () => {
  beforeEach(() => {
    resetMemoryJobs();
  });

  afterEach(() => {
    // Restore the default-enabled config so a disabled-case test cannot leak
    // into later tests sharing this process.
    setMemoryEnabled(true);
    throwFromIndex = false;
  });

  test("addMessage enqueues one index_message_lexical job for the persisted message", async () => {
    const conv = createConversation("Lexical persist thread");
    const message = await addMessage(conv.id, "user", "hello lexical world");

    const ids = lexicalJobMessageIds();
    expect(ids).toContain(message.id);
    expect(ids.filter((id) => id === message.id)).toHaveLength(1);
  });

  test("lexical job is still enqueued when segment indexing (indexMessageNow) throws", async () => {
    // The sparse lexical job is independent of the dense embedding path, so a
    // transient segment-indexing failure must not leave the message missing
    // from the lexical index. `addMessage` catches the hook throw as non-fatal.
    throwFromIndex = true;
    const conv = createConversation("Segment failure thread");
    const message = await addMessage(
      conv.id,
      "user",
      "index me despite failure",
    );

    expect(lexicalJobMessageIds()).toContain(message.id);
  });

  test("addMessage still enqueues an index_message_lexical job when memory is disabled", async () => {
    setMemoryEnabled(false);
    const conv = createConversation("Disabled memory thread");
    const message = await addMessage(
      conv.id,
      "user",
      "lexically indexed regardless of memory state",
    );

    expect(lexicalJobMessageIds()).toContain(message.id);
  });

  test("enqueueLexicalIndexForMessage no-ops on an empty message id", () => {
    enqueueLexicalIndexForMessage("");
    expect(countJobs("index_message_lexical")).toBe(0);
  });

  test("forking a conversation enqueues ZERO index_message_lexical jobs", async () => {
    const source = createConversation("Fork exclusion thread");
    // Persist source messages through the real path so each enqueues a lexical
    // job — this makes the "fork adds none" assertion meaningful.
    await addMessage(source.id, "user", "Draft a launch plan");
    await addMessage(source.id, "assistant", "Here is a first pass.");
    await addMessage(source.id, "user", "Fork from here");

    const beforeFork = countJobs("index_message_lexical");
    expect(beforeFork).toBe(3);

    // The fork copies every source row directly, bypassing onMessagePersisted.
    const fork = forkConversation({ conversationId: source.id });
    expect(fork.id).not.toBe(source.id);

    // No new lexical index jobs were enqueued for the copied fork rows.
    expect(countJobs("index_message_lexical")).toBe(beforeFork);
    // ...and specifically none of the fork's own message ids were enqueued.
    const enqueuedMessageIds = new Set(lexicalJobMessageIds());
    for (const forkMessage of getMessages(fork.id)) {
      expect(enqueuedMessageIds.has(forkMessage.id)).toBe(false);
    }
  });

  test("deleteConversation (direct, no route) enqueues a purge for the conversation", async () => {
    // Retrospective startup cleanup calls deleteConversation directly, bypassing
    // the HTTP route — the purge must still fire from the shared primitive.
    const conv = createConversation("Direct delete thread");
    await addMessage(conv.id, "user", "index me then delete me");

    resetMemoryJobs();
    deleteConversation(conv.id);

    expect(countJobs("purge_conversation_lexical", conv.id)).toBe(1);
  });

  test("deleteConversation fails pending conversation-keyed jobs but not the purge it enqueues", async () => {
    const conv = createConversation("Cancel pending jobs thread");
    await addMessage(conv.id, "user", "index me then delete me");

    resetMemoryJobs();
    enqueueMemoryJob("graph_extract", { conversationId: conv.id });

    deleteConversation(conv.id);

    const jobsByType = new Map(
      getMemoryDb()!
        .select({
          type: memoryJobs.type,
          status: memoryJobs.status,
          payload: memoryJobs.payload,
        })
        .from(memoryJobs)
        .all()
        .filter((r) => {
          try {
            return (
              (JSON.parse(r.payload) as { conversationId?: string })
                .conversationId === conv.id
            );
          } catch {
            return false;
          }
        })
        .map((r) => [r.type, r.status]),
    );

    // The pre-existing conversation-keyed job is swept…
    expect(jobsByType.get("graph_extract")).toBe("failed");
    // …but the purge, enqueued after the sweep, stays runnable.
    expect(jobsByType.get("purge_conversation_lexical")).toBe("pending");
  });

  test("deleteConversationGently (retrospective GC) enqueues a purge for the conversation", async () => {
    const conv = createConversation("Gentle delete thread");
    await addMessage(conv.id, "user", "index me then gently delete me");

    resetMemoryJobs();
    await deleteConversationGently(conv.id);

    expect(countJobs("purge_conversation_lexical", conv.id)).toBe(1);
  });

  test("deleteMessageById enqueues a delete_message_lexical job for the removed message", async () => {
    const conv = createConversation("Single delete thread");
    const message = await addMessage(conv.id, "user", "delete just me");

    resetMemoryJobs();
    deleteMessageById(message.id);

    const ids = getMemoryDb()!
      .select({ payload: memoryJobs.payload })
      .from(memoryJobs)
      .where(eq(memoryJobs.type, "delete_message_lexical"))
      .all()
      .map((r) => (JSON.parse(r.payload) as { messageId?: string }).messageId);
    expect(ids).toEqual([message.id]);
  });

  test("deleteMessageById for a nonexistent message enqueues nothing", () => {
    resetMemoryJobs();
    deleteMessageById("does-not-exist");
    expect(countJobs("delete_message_lexical")).toBe(0);
  });

  test("deleteLastExchange enqueues delete_message_lexical for every removed message", async () => {
    // Undo bulk-deletes the last user turn + everything after it via a single
    // `tx.delete(messages)`, bypassing `deleteMessageById`. It must still purge
    // each removed message's lexical point.
    const conv = createConversation("Undo thread");
    await addMessage(conv.id, "user", "first user turn");
    await addMessage(conv.id, "assistant", "first assistant reply");
    const lastUser = await addMessage(conv.id, "user", "undo this turn");
    const lastAssistant = await addMessage(
      conv.id,
      "assistant",
      "and this reply",
    );

    resetMemoryJobs();
    const removed = deleteLastExchange(conv.id);
    expect(removed).toBe(2);

    const deletedIds = getMemoryDb()!
      .select({ payload: memoryJobs.payload })
      .from(memoryJobs)
      .where(eq(memoryJobs.type, "delete_message_lexical"))
      .all()
      .map((r) => (JSON.parse(r.payload) as { messageId?: string }).messageId);
    expect(new Set(deletedIds)).toEqual(
      new Set([lastUser.id, lastAssistant.id]),
    );
  });

  test("updateMessageContent (CRUD primitive) does not enqueue a reindex on its own", async () => {
    // The reindex is owned by the semantic seams (streaming finalize, edits,
    // consolidation), NOT the low-level primitive — this keeps mid-stream
    // partial flushes and tool-timing stamps from spamming reindex jobs.
    const conv = createConversation("Raw update thread");
    const message = await addMessage(conv.id, "user", "original text");

    resetMemoryJobs();
    updateMessageContent(
      message.id,
      JSON.stringify([{ type: "text", text: "edited text" }]),
    );

    expect(countJobs("index_message_lexical")).toBe(0);
  });

  test("consolidation reindexes the retained message and purges the merged-away rows", async () => {
    const conv = createConversation("Consolidation thread");
    const userMsg = await addMessage(conv.id, "user", "do a multi-step task");
    const retained = await addMessage(
      conv.id,
      "assistant",
      JSON.stringify([{ type: "text", text: "first assistant segment" }]),
    );
    const mergedAway = await addMessage(
      conv.id,
      "assistant",
      JSON.stringify([{ type: "text", text: "second assistant segment" }]),
    );

    resetMemoryJobs();
    const didConsolidate = consolidateAssistantMessages(conv.id, userMsg.id);
    expect(didConsolidate).toBe(true);

    // The retained (first) assistant row is reindexed with the merged content.
    expect(lexicalJobMessageIds()).toContain(retained.id);
    // The merged-away row's point is removed via delete_message_lexical.
    const deletedIds = getMemoryDb()!
      .select({ payload: memoryJobs.payload })
      .from(memoryJobs)
      .where(eq(memoryJobs.type, "delete_message_lexical"))
      .all()
      .map((r) => (JSON.parse(r.payload) as { messageId?: string }).messageId);
    expect(deletedIds).toContain(mergedAway.id);
    // The retained row is not itself scheduled for deletion.
    expect(deletedIds).not.toContain(retained.id);
  });
});

// The delete paths must route their cleanup through the persistence-hook seam
// rather than importing memory internals directly, so persistence stays
// decoupled from the plugin: single-message deletes fire `onMessagesDeleted`,
// and whole-conversation deletes fire `onConversationDeleted` from the shared
// `deleteConversation`/`deleteConversationGently` primitive (covering every
// caller, not just the HTTP route).
describe("delete paths route through the memory persistence hooks", () => {
  const deletedBatches: string[][] = [];
  const deletedConversations: string[] = [];
  let conversationDeletedSpy: ReturnType<typeof spyOn>;
  let messagesDeletedSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    resetMemoryJobs();
    deletedBatches.length = 0;
    deletedConversations.length = 0;
    conversationDeletedSpy = spyOn(
      memoryPersistenceHooks,
      "onConversationDeleted",
    ).mockImplementation((id: string) => {
      deletedConversations.push(id);
    });
    messagesDeletedSpy = spyOn(
      memoryPersistenceHooks,
      "onMessagesDeleted",
    ).mockImplementation((ids: string[]) => {
      deletedBatches.push(ids);
    });
  });

  afterEach(() => {
    // Restore the real handlers so later tests are unaffected.
    conversationDeletedSpy.mockRestore();
    messagesDeletedSpy.mockRestore();
  });

  test("deleteConversation fires onConversationDeleted (covers all callers, not just the route)", async () => {
    const conv = createConversation("Seam conversation delete");
    await addMessage(conv.id, "user", "hello");

    deletedConversations.length = 0;
    deleteConversation(conv.id);

    expect(deletedConversations).toEqual([conv.id]);
  });

  test("deleteConversationGently fires onConversationDeleted (the retrospective-GC path)", async () => {
    const conv = createConversation("Seam gentle delete");
    await addMessage(conv.id, "user", "hello");

    deletedConversations.length = 0;
    await deleteConversationGently(conv.id);

    expect(deletedConversations).toEqual([conv.id]);
  });

  test("deleteMessageById fires onMessagesDeleted with the single id", async () => {
    const conv = createConversation("Seam single delete");
    const message = await addMessage(conv.id, "user", "delete me via seam");

    deletedBatches.length = 0;
    deleteMessageById(message.id);

    expect(deletedBatches).toEqual([[message.id]]);
  });

  test("deleteLastExchange fires onMessagesDeleted with every removed id", async () => {
    const conv = createConversation("Seam undo");
    await addMessage(conv.id, "user", "first turn");
    await addMessage(conv.id, "assistant", "first reply");
    const lastUser = await addMessage(conv.id, "user", "undo this");
    const lastAssistant = await addMessage(conv.id, "assistant", "and this");

    deletedBatches.length = 0;
    deleteLastExchange(conv.id);

    expect(deletedBatches).toHaveLength(1);
    expect(new Set(deletedBatches[0])).toEqual(
      new Set([lastUser.id, lastAssistant.id]),
    );
  });
});
