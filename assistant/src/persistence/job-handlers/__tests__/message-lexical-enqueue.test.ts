// Message-content lexical indexing is host infrastructure: the enqueue
// helpers schedule jobs unconditionally — regardless of `memory.enabled` or
// the memory plugin's `.disabled` sentinel — and never touch Qdrant inline.
// (The job worker drains the lexical types even while memory is disabled.)

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { eq } from "drizzle-orm";

import { makeMockLogger } from "../../../__tests__/helpers/mock-logger.js";

mock.module("../../../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
}));

// Spread the real lexical-index module and override only the singleton
// accessors to return a fake that records any inline delete calls (there
// should be none — the helpers are enqueue-only). Spreading keeps the module's
// other exports intact so this partial mock cannot leak into sibling test
// files that import them.
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
  await import("../../embeddings/messages-lexical-index.js");
mock.module("../../embeddings/messages-lexical-index.js", () => ({
  ...actualLexicalIndex,
  getMessagesLexicalIndex: () => fakeIndex,
  initMessagesLexicalIndex: () => fakeIndex,
}));

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  getConfig,
  invalidateConfigCache,
  loadRawConfig,
  saveRawConfig,
} from "../../../config/loader.js";
import { getWorkspacePluginsDir } from "../../../util/platform.js";
import { getMemoryDb } from "../../db-connection.js";
import { initializeDb } from "../../db-init.js";
import { memoryJobs } from "../../schema/index.js";
const MEMORY_PLUGIN_NAME = "default-memory";
import {
  enqueueDeleteMessageLexical,
  enqueueLexicalIndexForMessage,
  enqueuePurgeConversationLexical,
} from "../message-lexical.js";

await initializeDb();

function memoryPluginDir(): string {
  return join(getWorkspacePluginsDir(), MEMORY_PLUGIN_NAME);
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

// Let any stray fire-and-forget promise settle before asserting.
const flush = () => new Promise((r) => setTimeout(r, 5));

beforeEach(() => {
  getMemoryDb()!.delete(memoryJobs).run();
  deleteByConversationCalls.length = 0;
  deleteByMessageIdCalls.length = 0;
  setMemoryEnabled(true);
  setMemoryPluginDisabled(false);
});

describe("lexical enqueues with memory enabled", () => {
  test("index, purge, and delete each enqueue a job and never touch Qdrant inline", async () => {
    enqueueLexicalIndexForMessage("msg-1");
    enqueuePurgeConversationLexical("conv-1");
    enqueueDeleteMessageLexical("msg-2");
    await flush();
    expect(jobCount("index_message_lexical")).toBe(1);
    expect(jobCount("purge_conversation_lexical")).toBe(1);
    expect(jobCount("delete_message_lexical")).toBe(1);
    expect(deleteByConversationCalls).toEqual([]);
    expect(deleteByMessageIdCalls).toEqual([]);
  });
});

describe("lexical enqueues with memory DISABLED — unchanged", () => {
  test("index, purge, and delete still enqueue jobs (the worker drains lexical types while memory is off)", async () => {
    setMemoryEnabled(false);
    enqueueLexicalIndexForMessage("msg-9");
    enqueuePurgeConversationLexical("conv-9");
    enqueueDeleteMessageLexical("msg-10");
    await flush();
    expect(jobCount("index_message_lexical")).toBe(1);
    expect(jobCount("purge_conversation_lexical")).toBe(1);
    expect(jobCount("delete_message_lexical")).toBe(1);
    expect(deleteByConversationCalls).toEqual([]);
    expect(deleteByMessageIdCalls).toEqual([]);
    // Sanity: config really is disabled for this test.
    expect(getConfig().memory.enabled).toBe(false);
  });

  test("empty ids no-op", async () => {
    setMemoryEnabled(false);
    enqueueLexicalIndexForMessage("");
    enqueuePurgeConversationLexical("");
    enqueueDeleteMessageLexical("");
    await flush();
    expect(jobCount("index_message_lexical")).toBe(0);
    expect(jobCount("purge_conversation_lexical")).toBe(0);
    expect(jobCount("delete_message_lexical")).toBe(0);
  });
});

describe("plugin disabled via the .disabled sentinel — unchanged", () => {
  test("index write still enqueues (search indexing is not a plugin feature)", async () => {
    setMemoryPluginDisabled(true);
    enqueueLexicalIndexForMessage("msg-idx");
    await flush();
    expect(jobCount("index_message_lexical")).toBe(1);
  });

  test("cleanup still enqueues purge + delete jobs", async () => {
    setMemoryPluginDisabled(true);
    enqueuePurgeConversationLexical("conv-x");
    enqueueDeleteMessageLexical("msg-x");
    await flush();
    expect(jobCount("purge_conversation_lexical")).toBe(1);
    expect(jobCount("delete_message_lexical")).toBe(1);
    expect(deleteByConversationCalls).toEqual([]);
    expect(deleteByMessageIdCalls).toEqual([]);
  });
});
