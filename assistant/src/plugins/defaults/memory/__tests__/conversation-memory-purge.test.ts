/**
 * Purge coverage for the memory `conversation-deleted` and
 * `conversations-cleared` hooks: deleting a conversation removes its rows — and
 * only its rows — from the relocated per-conversation memory tables, the
 * clear-all reset wipes those tables wholesale, and both degrade to a no-op
 * when the memory connection is unavailable.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type {
  ConversationDeletedContext,
  ConversationsClearedContext,
  HookFunction,
} from "@vellumai/plugin-api";

import type { DrizzleDb } from "../../../../persistence/db-connection.js";
import { getMemorySqlite } from "../../../../persistence/db-connection.js";
import { initializeDb } from "../../../../persistence/db-init.js";
import {
  clearStoredDb,
  setStoredDb,
} from "../../../../persistence/db-singleton.js";
import {
  clearAllConversationMemoryTables,
  CONVERSATION_KEYED_MEMORY_TABLES,
  purgeConversationMemoryTables,
} from "../conversation-memory-purge.js";
import conversationDeleted from "../hooks/conversation-deleted.js";
import conversationsCleared from "../hooks/conversations-cleared.js";
import {
  relocatedMemoryRowCount as rowCount,
  seedRelocatedMemoryRow as seedRow,
} from "./relocated-memory-test-rows.js";

await initializeDb();

async function runHook(conversationId: string): Promise<void> {
  const hook = conversationDeleted as HookFunction<ConversationDeletedContext>;
  await hook({ conversationId } as ConversationDeletedContext);
}

async function runClearedHook(): Promise<void> {
  const hook =
    conversationsCleared as HookFunction<ConversationsClearedContext>;
  await hook({} as ConversationsClearedContext);
}

describe("conversation memory purge", () => {
  beforeEach(() => {
    for (const table of CONVERSATION_KEYED_MEMORY_TABLES) {
      getMemorySqlite()!.exec(`DELETE FROM ${table}`);
    }
  });

  test("the shared table list covers every relocated per-conversation table", () => {
    expect([...CONVERSATION_KEYED_MEMORY_TABLES].sort()).toEqual(
      [
        "activation_sessions",
        "activation_state",
        "conversation_graph_memory_state",
        "memory_recall_logs",
        "memory_v2_activation_logs",
        "memory_v3_selections",
      ].sort(),
    );
  });

  test("the hook deletes the deleted conversation's rows from every table", async () => {
    for (const table of CONVERSATION_KEYED_MEMORY_TABLES) {
      seedRow(table, "doomed");
    }

    await runHook("doomed");

    for (const table of CONVERSATION_KEYED_MEMORY_TABLES) {
      expect(rowCount(table, "doomed")).toBe(0);
    }
  });

  test("the purge leaves other conversations' rows untouched", () => {
    for (const table of CONVERSATION_KEYED_MEMORY_TABLES) {
      seedRow(table, "doomed");
      seedRow(table, "survivor");
    }

    purgeConversationMemoryTables("doomed");

    for (const table of CONVERSATION_KEYED_MEMORY_TABLES) {
      expect(rowCount(table, "doomed")).toBe(0);
      expect(rowCount(table, "survivor")).toBe(1);
    }
  });

  test("the clear-all hook wipes every relocated table for every conversation", async () => {
    // A table added to the shared array is wiped here without touching this
    // test — clearAll drops all conversations, so no id survives.
    for (const table of CONVERSATION_KEYED_MEMORY_TABLES) {
      seedRow(table, "conv-a");
      seedRow(table, "conv-b");
    }

    await runClearedHook();

    for (const table of CONVERSATION_KEYED_MEMORY_TABLES) {
      expect(rowCount(table, "conv-a")).toBe(0);
      expect(rowCount(table, "conv-b")).toBe(0);
    }
  });
});

describe("conversation memory purge without a memory database", () => {
  // Install a connection with no underlying sqlite client so
  // getMemorySqlite() resolves to null without mocking any module.
  beforeEach(() => {
    setStoredDb("memory", { $client: null } as unknown as DrizzleDb, () => {});
  });

  afterEach(() => {
    clearStoredDb("memory");
  });

  test("the purge no-ops without throwing when the memory DB is unavailable", () => {
    expect(() => purgeConversationMemoryTables("doomed")).not.toThrow();
  });

  test("the clear-all wipe no-ops without throwing when the memory DB is unavailable", () => {
    expect(() => clearAllConversationMemoryTables()).not.toThrow();
  });
});
