/**
 * Startup orphan sweep for the relocated conversation-keyed memory tables:
 * rows whose conversation no longer exists (e.g. deleted while the memory
 * plugin was disabled, so the conversation-deleted hook never fired) are
 * deleted; rows for live conversations are kept; and the sweep no-ops when the
 * memory connection is unavailable.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { DrizzleDb } from "../../../../persistence/db-connection.js";
import {
  getDb,
  getMemorySqlite,
} from "../../../../persistence/db-connection.js";
import { initializeDb } from "../../../../persistence/db-init.js";
import {
  clearStoredDb,
  setStoredDb,
} from "../../../../persistence/db-singleton.js";
import { conversations } from "../../../../persistence/schema/index.js";
import { sweepOrphanConversationMemoryTables } from "../conversation-memory-orphan-sweep.js";
import { CONVERSATION_KEYED_MEMORY_TABLES } from "../conversation-memory-purge.js";
import {
  relocatedMemoryRowCount as rowCount,
  seedRelocatedMemoryRow as seedRow,
} from "./relocated-memory-test-rows.js";

await initializeDb();

function seedConversation(id: string): void {
  getDb()
    .insert(conversations)
    .values({ id, title: "test", createdAt: 1, updatedAt: 1 })
    .run();
}

describe("relocated memory orphan sweep", () => {
  beforeEach(() => {
    getDb().delete(conversations).run();
    for (const table of CONVERSATION_KEYED_MEMORY_TABLES) {
      getMemorySqlite()!.exec(`DELETE FROM ${table}`);
    }
  });

  test("deletes rows for missing conversations and keeps rows for live ones", async () => {
    seedConversation("alive");
    // "orphan" has no conversations row — its memory rows are stranded.
    for (const table of CONVERSATION_KEYED_MEMORY_TABLES) {
      seedRow(table, "alive");
      seedRow(table, "orphan");
    }

    const { swept } = await sweepOrphanConversationMemoryTables();

    // One orphan row per relocated table. A table added to the shared array is
    // swept here without touching this test.
    expect(swept).toBe(CONVERSATION_KEYED_MEMORY_TABLES.length);
    for (const table of CONVERSATION_KEYED_MEMORY_TABLES) {
      expect(rowCount(table, "orphan")).toBe(0);
      expect(rowCount(table, "alive")).toBe(1);
    }
  });

  test("no-ops when every conversation is still live", async () => {
    seedConversation("alive");
    for (const table of CONVERSATION_KEYED_MEMORY_TABLES) {
      seedRow(table, "alive");
    }

    const { swept } = await sweepOrphanConversationMemoryTables();

    expect(swept).toBe(0);
    for (const table of CONVERSATION_KEYED_MEMORY_TABLES) {
      expect(rowCount(table, "alive")).toBe(1);
    }
  });
});

describe("relocated memory orphan sweep without a memory database", () => {
  beforeEach(() => {
    setStoredDb("memory", { $client: null } as unknown as DrizzleDb, () => {});
  });

  afterEach(() => {
    clearStoredDb("memory");
  });

  test("no-ops without throwing when the memory DB is unavailable", async () => {
    expect(await sweepOrphanConversationMemoryTables()).toEqual({ swept: 0 });
  });
});
