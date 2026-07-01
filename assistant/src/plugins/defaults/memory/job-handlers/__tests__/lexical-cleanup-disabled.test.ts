// When memory is DISABLED the memory job worker skips every job
// (`runMemoryJobsOnce` returns early), so an enqueued cleanup job would sit
// pending forever and its Qdrant points would leak. But Qdrant itself is still
// up (daemon startup boots it unconditionally, independent of `memory.enabled`),
// so the cleanup enqueue helpers run the purge/delete INLINE instead. These
// tests verify that split: enqueue when enabled, inline Qdrant delete when
// disabled — for the cleanup paths only.

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { eq } from "drizzle-orm";

import { makeMockLogger } from "../../../../../__tests__/helpers/mock-logger.js";

mock.module("../../../../../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
}));

// Spread the real lexical-index module and override only the singleton
// accessors to return a fake that records the inline delete calls. Spreading
// keeps the module's other exports (`MessagesLexicalIndex`, `messagePointId`)
// intact so this partial mock cannot leak into sibling test files that import
// them. Its deps (`@qdrant/js-client-rest`, `uuid`) resolve in the worktree.
const deleteByConversationCalls: string[] = [];
const deleteByMessageIdCalls: string[] = [];
const fakeIndex = {
  deleteByConversation: async (conversationId: string) => {
    deleteByConversationCalls.push(conversationId);
  },
  deleteByMessageId: async (messageId: string) => {
    deleteByMessageIdCalls.push(messageId);
  },
};
const actualLexicalIndex =
  await import("../../../../../persistence/embeddings/messages-lexical-index.js");
mock.module(
  "../../../../../persistence/embeddings/messages-lexical-index.js",
  () => ({
    ...actualLexicalIndex,
    getMessagesLexicalIndex: () => fakeIndex,
    initMessagesLexicalIndex: () => fakeIndex,
  }),
);

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  getConfig,
  invalidateConfigCache,
  loadRawConfig,
  saveRawConfig,
} from "../../../../../config/loader.js";
import { getMemoryDb } from "../../../../../persistence/db-connection.js";
import { initializeDb } from "../../../../../persistence/db-init.js";
import { memoryJobs } from "../../../../../persistence/schema/index.js";
import { getWorkspacePluginsDir } from "../../../../../util/platform.js";
import memoryPkg from "../../package.json" with { type: "json" };
import {
  enqueueDeleteMessageLexical,
  enqueueLexicalIndexForMessage,
  enqueuePurgeConversationLexical,
} from "../index-message-lexical.js";

await initializeDb();

function memoryPluginDir(): string {
  return join(getWorkspacePluginsDir(), memoryPkg.name);
}

function setMemoryPluginDisabled(disabled: boolean): void {
  const dir = memoryPluginDir();
  if (disabled) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".disabled"), "");
  } else {
    rmSync(dir, { recursive: true, force: true });
  }
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

function jobCount(type: string): number {
  return getMemoryDb()!
    .select({ id: memoryJobs.id })
    .from(memoryJobs)
    .where(eq(memoryJobs.type, type))
    .all().length;
}

// Let the fire-and-forget inline promise settle.
const flush = () => new Promise((r) => setTimeout(r, 5));

beforeEach(() => {
  getMemoryDb()!.delete(memoryJobs).run();
  deleteByConversationCalls.length = 0;
  deleteByMessageIdCalls.length = 0;
  setMemoryEnabled(true);
  setMemoryPluginDisabled(false);
});

describe("lexical cleanup when memory is enabled — enqueues a job", () => {
  test("purge enqueues a job and does NOT delete inline", async () => {
    enqueuePurgeConversationLexical("conv-1");
    await flush();
    expect(jobCount("purge_conversation_lexical")).toBe(1);
    expect(deleteByConversationCalls).toEqual([]);
  });

  test("delete enqueues a job and does NOT delete inline", async () => {
    enqueueDeleteMessageLexical("msg-1");
    await flush();
    expect(jobCount("delete_message_lexical")).toBe(1);
    expect(deleteByMessageIdCalls).toEqual([]);
  });
});

describe("lexical cleanup when memory is DISABLED — runs inline", () => {
  test("purge deletes the conversation inline and enqueues NO job", async () => {
    setMemoryEnabled(false);
    enqueuePurgeConversationLexical("conv-9");
    await flush();
    expect(deleteByConversationCalls).toEqual(["conv-9"]);
    expect(jobCount("purge_conversation_lexical")).toBe(0);
  });

  test("delete removes the message point inline and enqueues NO job", async () => {
    setMemoryEnabled(false);
    enqueueDeleteMessageLexical("msg-9");
    await flush();
    expect(deleteByMessageIdCalls).toEqual(["msg-9"]);
    expect(jobCount("delete_message_lexical")).toBe(0);
  });

  test("empty ids no-op in both modes", async () => {
    setMemoryEnabled(false);
    enqueuePurgeConversationLexical("");
    enqueueDeleteMessageLexical("");
    await flush();
    expect(deleteByConversationCalls).toEqual([]);
    expect(deleteByMessageIdCalls).toEqual([]);
    // Sanity: config really is disabled for this test.
    expect(getConfig().memory.enabled).toBe(false);
  });
});

// The INDEX/write path must honor the plugin's `.disabled` sentinel (the same
// full disabled-state check the host applies in the guarded hook seam), because
// the direct index-write callers (finalize/import/edit/consolidation) run
// outside that guard. The CLEANUP paths must still run while disabled so points
// written when enabled are not orphaned.
describe("plugin disabled via the .disabled sentinel (config still enabled)", () => {
  test("index write is suppressed — enqueues NO index_message_lexical job", async () => {
    setMemoryPluginDisabled(true);
    enqueueLexicalIndexForMessage("msg-idx");
    await flush();
    expect(jobCount("index_message_lexical")).toBe(0);
  });

  test("index write resumes once the sentinel is removed", async () => {
    setMemoryPluginDisabled(true);
    enqueueLexicalIndexForMessage("msg-a");
    setMemoryPluginDisabled(false);
    enqueueLexicalIndexForMessage("msg-b");
    await flush();
    // Only the post-enable write was indexed.
    const ids = getMemoryDb()!
      .select({ payload: memoryJobs.payload })
      .from(memoryJobs)
      .where(eq(memoryJobs.type, "index_message_lexical"))
      .all()
      .map((r) => (JSON.parse(r.payload) as { messageId?: string }).messageId);
    expect(ids).toEqual(["msg-b"]);
  });

  test("cleanup STILL runs while the plugin is disabled — enqueues purge + delete jobs", async () => {
    setMemoryPluginDisabled(true);
    enqueuePurgeConversationLexical("conv-x");
    enqueueDeleteMessageLexical("msg-x");
    await flush();
    // Config is still enabled, so cleanup takes the enqueue path (the worker
    // does not gate on the `.disabled` sentinel, so these jobs drain).
    expect(jobCount("purge_conversation_lexical")).toBe(1);
    expect(jobCount("delete_message_lexical")).toBe(1);
    // ...and it did not run inline (config enabled → enqueue, not inline).
    expect(deleteByConversationCalls).toEqual([]);
    expect(deleteByMessageIdCalls).toEqual([]);
  });
});
