// Integration coverage for the messages lexical-index dual-write wiring:
//   - a real persist (`addMessage` → `onMessagePersisted`) enqueues one
//     `index_message_lexical` job for the message when memory is enabled, and
//     none when memory is disabled;
//   - forking a conversation copies message rows WITHOUT routing through
//     `onMessagePersisted`, so a fork enqueues ZERO `index_message_lexical`
//     jobs (the fork-exclusion regression);
//   - wiping a conversation enqueues one `purge_conversation_lexical` job.
//
// The heavy segment indexer (`indexMessageNow`) is stubbed to a no-op so these
// tests exercise only the lexical enqueue seam, not the embedding/extraction
// machinery. Memory config is real (default-enabled), flipped on disk for the
// disabled case.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { eq } from "drizzle-orm";

import { makeMockLogger } from "./helpers/mock-logger.js";

mock.module("../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
}));

// Stub the segment indexer so `onMessagePersisted` runs cheaply. The lexical
// enqueue in the hook is a separate call and still fires. Other exports are
// provided so any transitive importer of this module resolves.
mock.module("../plugins/defaults/memory/indexer.js", () => ({
  MIN_SEGMENT_CHARS: 50,
  indexMessageNow: async () => ({ indexedSegments: 0, enqueuedJobs: 0 }),
  enqueueBackfillJob: () => "",
  enqueueRebuildIndexJob: () => "",
}));

import {
  invalidateConfigCache,
  loadRawConfig,
  saveRawConfig,
} from "../config/loader.js";
import {
  addMessage,
  createConversation,
  forkConversation,
  getMessages,
  wipeConversation,
} from "../persistence/conversation-crud.js";
import { getMemoryDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import type { MemoryJobType } from "../persistence/jobs-store.js";
import { memoryJobs } from "../persistence/schema/index.js";
import { registerDefaultPluginPersistenceHooks } from "../plugins/defaults/index.js";
import { enqueueLexicalIndexForMessage } from "../plugins/defaults/memory/job-handlers/index-message-lexical.js";

await initializeDb();

function countJobs(type: MemoryJobType, conversationId?: string): number {
  const rows = getMemoryDb()!
    .select({ payload: memoryJobs.payload })
    .from(memoryJobs)
    .where(eq(memoryJobs.type, type))
    .all();
  if (conversationId == null) return rows.length;
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
    registerDefaultPluginPersistenceHooks();
  });

  afterEach(() => {
    // Restore the default-enabled config so a disabled-case test cannot leak
    // into later tests sharing this process.
    setMemoryEnabled(true);
  });

  test("addMessage enqueues one index_message_lexical job for the persisted message", async () => {
    const conv = createConversation("Lexical persist thread");
    const message = await addMessage(conv.id, "user", "hello lexical world");

    const ids = lexicalJobMessageIds();
    expect(ids).toContain(message.id);
    expect(ids.filter((id) => id === message.id)).toHaveLength(1);
  });

  test("addMessage enqueues NO index_message_lexical job when memory is disabled", async () => {
    setMemoryEnabled(false);
    const conv = createConversation("Disabled memory thread");
    await addMessage(conv.id, "user", "should not be lexically indexed");

    expect(countJobs("index_message_lexical")).toBe(0);
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

  test("wipeConversation enqueues a purge_conversation_lexical job for the conversation", async () => {
    const conv = createConversation("Lexical wipe thread");
    await addMessage(conv.id, "user", "index me then wipe me");

    resetMemoryJobs();
    wipeConversation(conv.id);

    expect(countJobs("purge_conversation_lexical", conv.id)).toBe(1);
  });
});
