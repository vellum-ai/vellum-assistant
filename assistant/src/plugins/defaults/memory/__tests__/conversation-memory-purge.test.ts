/**
 * Purge coverage for the memory `conversation-deleted` hook: deleting a
 * conversation removes its rows — and only its rows — from the relocated
 * per-conversation memory tables on the memory connection, and degrades to a
 * no-op when that connection is unavailable.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type {
  ConversationDeletedContext,
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
  CONVERSATION_KEYED_MEMORY_TABLES,
  purgeConversationMemoryTables,
} from "../conversation-memory-purge.js";
import conversationDeleted from "../hooks/conversation-deleted.js";

await initializeDb();

async function runHook(conversationId: string): Promise<void> {
  const hook = conversationDeleted as HookFunction<ConversationDeletedContext>;
  await hook({ conversationId } as ConversationDeletedContext);
}

function seedRow(table: string, conversationId: string): void {
  const raw = getMemorySqlite()!;
  const now = Date.now();
  switch (table) {
    case "memory_v2_activation_logs":
      raw
        .query(
          `INSERT INTO memory_v2_activation_logs
             (id, conversation_id, turn, mode, concepts_json, skills_json, config_json, created_at)
           VALUES (?, ?, 1, 'per-turn', '[]', '[]', '{}', ?)`,
        )
        .run(`${conversationId}-al`, conversationId, now);
      return;
    case "memory_recall_logs":
      raw
        .query(
          `INSERT INTO memory_recall_logs
             (id, conversation_id, enabled, degraded, semantic_hits, merged_count,
              selected_count, tier1_count, tier2_count, hybrid_search_latency_ms,
              sparse_vector_used, injected_tokens, latency_ms, top_candidates_json, created_at)
           VALUES (?, ?, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, '[]', ?)`,
        )
        .run(`${conversationId}-rl`, conversationId, now);
      return;
    case "memory_v3_selections":
      raw
        .query(
          `INSERT INTO memory_v3_selections
             (conversation_id, turn, slug, source, created_at)
           VALUES (?, 1, 'domain/page', 'auto', ?)`,
        )
        .run(conversationId, now);
      return;
    case "activation_sessions":
      raw
        .query(
          `INSERT INTO activation_sessions (conversation_id, created_at) VALUES (?, ?)`,
        )
        .run(conversationId, now);
      return;
    default:
      throw new Error(`unhandled table ${table}`);
  }
}

function rowCount(table: string, conversationId: string): number {
  const { n } = getMemorySqlite()!
    .query(`SELECT COUNT(*) AS n FROM ${table} WHERE conversation_id = ?`)
    .get(conversationId) as { n: number };
  return n;
}

describe("conversation memory purge", () => {
  beforeEach(() => {
    for (const table of CONVERSATION_KEYED_MEMORY_TABLES) {
      getMemorySqlite()!.exec(`DELETE FROM ${table}`);
    }
  });

  test("the shared table list covers the four relocated Wave 1 tables", () => {
    expect([...CONVERSATION_KEYED_MEMORY_TABLES].sort()).toEqual(
      [
        "activation_sessions",
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
});
