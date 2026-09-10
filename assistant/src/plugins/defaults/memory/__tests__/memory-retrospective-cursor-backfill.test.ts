import { beforeEach, describe, expect, test } from "bun:test";

import { setConfig } from "../../../../__tests__/helpers/set-config.js";

// Disable memory so persistence writes don't index into the real memory
// pipeline (both flags default true under the real loader).
setConfig("memory", { enabled: false, v2: { enabled: false } });

import { createConversation } from "../../../../persistence/conversation-crud.js";
import {
  getDb,
  getMemorySqlite,
} from "../../../../persistence/db-connection.js";
import { initializeDb } from "../../../../persistence/db-init.js";
import { messages } from "../../../../persistence/schema/index.js";
import { backfillRetrospectiveCursorTimestamps } from "../memory-retrospective-cursor-backfill.js";
import {
  ensureRetrospectiveCursorColumn,
  getRetrospectiveState,
} from "../memory-retrospective-state.js";

await initializeDb();

function resetTables(): void {
  const db = getDb();
  db.run(`DELETE FROM messages`);
  db.run(`DELETE FROM conversations`);
  getMemorySqlite()!.exec(`DELETE FROM memory_retrospective_state`);
}

/** A state row as written before the timestamp column existed. */
function insertLegacyState(conversationId: string, messageId: string): void {
  ensureRetrospectiveCursorColumn("test");
  getMemorySqlite()!
    .query(
      `INSERT INTO memory_retrospective_state
         (conversation_id, last_processed_message_id, last_run_at, remembered_log, last_processed_created_at)
       VALUES (?, ?, 1, NULL, NULL)`,
    )
    .run(conversationId, messageId);
}

function insertMessage(
  conversationId: string,
  id: string,
  createdAt: number,
): void {
  getDb()
    .insert(messages)
    .values({
      id,
      conversationId,
      role: "user",
      content: "[]",
      createdAt,
      metadata: null,
    })
    .run();
}

describe("backfillRetrospectiveCursorTimestamps", () => {
  beforeEach(() => {
    resetTables();
  });

  test("fills the timestamp from the cursor's message, leaves vanished cursors NULL, and is idempotent", async () => {
    createConversation({ id: "conv-a" });
    createConversation({ id: "conv-b" });
    createConversation({ id: "conv-c" });
    insertMessage("conv-a", "a-m1", 1_000);
    insertLegacyState("conv-a", "a-m1");
    // Cursor row already deleted: nothing left to recover.
    insertLegacyState("conv-b", "gone");
    // The failure-only sentinel is never a cursor, so it is never scanned.
    insertLegacyState("conv-c", "");

    const first = await backfillRetrospectiveCursorTimestamps();

    expect(first).toEqual({ scanned: 2, backfilled: 1, unrecoverable: 1 });
    expect(getRetrospectiveState("conv-a")?.lastProcessedCreatedAt).toBe(1_000);
    expect(getRetrospectiveState("conv-b")?.lastProcessedCreatedAt).toBeNull();
    expect(getRetrospectiveState("conv-c")?.lastProcessedCreatedAt).toBeNull();

    const second = await backfillRetrospectiveCursorTimestamps();

    expect(second).toEqual({ scanned: 1, backfilled: 0, unrecoverable: 1 });
  });

  test("pages through the backlog by conversation id, advancing past unrecoverable rows", async () => {
    for (const id of ["conv-1", "conv-2", "conv-3", "conv-4", "conv-5"]) {
      createConversation({ id });
    }
    insertMessage("conv-1", "m-1", 1_000);
    insertLegacyState("conv-1", "m-1");
    insertLegacyState("conv-2", "gone-2");
    insertMessage("conv-3", "m-3", 3_000);
    insertLegacyState("conv-3", "m-3");
    insertLegacyState("conv-4", "gone-4");
    insertMessage("conv-5", "m-5", 5_000);
    insertLegacyState("conv-5", "m-5");

    const result = await backfillRetrospectiveCursorTimestamps({ pageSize: 2 });

    expect(result).toEqual({ scanned: 5, backfilled: 3, unrecoverable: 2 });
    expect(getRetrospectiveState("conv-1")?.lastProcessedCreatedAt).toBe(1_000);
    expect(getRetrospectiveState("conv-3")?.lastProcessedCreatedAt).toBe(3_000);
    expect(getRetrospectiveState("conv-5")?.lastProcessedCreatedAt).toBe(5_000);
    expect(getRetrospectiveState("conv-4")?.lastProcessedCreatedAt).toBeNull();
  });

  test("a table with nothing to fill is a clean no-op", async () => {
    expect(await backfillRetrospectiveCursorTimestamps()).toEqual({
      scanned: 0,
      backfilled: 0,
      unrecoverable: 0,
    });
  });
});
