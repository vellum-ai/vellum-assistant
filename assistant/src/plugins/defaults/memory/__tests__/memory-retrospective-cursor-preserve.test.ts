import { beforeEach, describe, expect, test } from "bun:test";

import { setConfig } from "../../../../__tests__/helpers/set-config.js";

// Disable memory so persistence writes don't index into the real memory
// pipeline (both flags default true under the real loader).
setConfig("memory", { enabled: false, v2: { enabled: false } });

import { getMemorySqlite } from "../../../../persistence/db-connection.js";
import { initializeDb } from "../../../../persistence/db-init.js";
import { preserveRetrospectiveCursorTimestamps } from "../memory-retrospective-cursor-preserve.js";
import {
  ensureRetrospectiveCursorColumn,
  getRetrospectiveState,
  upsertRetrospectiveState,
} from "../memory-retrospective-state.js";

await initializeDb();

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

describe("preserveRetrospectiveCursorTimestamps", () => {
  beforeEach(() => {
    getMemorySqlite()!.exec(`DELETE FROM memory_retrospective_state`);
  });

  test("records the timestamp of a legacy cursor whose row is about to be deleted", async () => {
    insertLegacyState("conv-a", "reply-1");

    await preserveRetrospectiveCursorTimestamps("conv-a", [
      { id: "tool-1", createdAt: 1_500 },
      { id: "reply-1", createdAt: 2_000 },
    ]);

    expect(getRetrospectiveState("conv-a")?.lastProcessedCreatedAt).toBe(2_000);
  });

  test("leaves a cursor that already has a timestamp, points elsewhere, or does not exist untouched", async () => {
    await upsertRetrospectiveState({
      conversationId: "conv-stamped",
      lastProcessedMessageId: "reply-1",
      lastProcessedCreatedAt: 1_000,
      lastRunAt: 1,
    });
    insertLegacyState("conv-elsewhere", "older-reply");

    await preserveRetrospectiveCursorTimestamps("conv-stamped", [
      { id: "reply-1", createdAt: 9_999 },
    ]);
    await preserveRetrospectiveCursorTimestamps("conv-elsewhere", [
      { id: "reply-1", createdAt: 9_999 },
    ]);
    await preserveRetrospectiveCursorTimestamps("conv-missing", [
      { id: "reply-1", createdAt: 9_999 },
    ]);

    expect(getRetrospectiveState("conv-stamped")?.lastProcessedCreatedAt).toBe(
      1_000,
    );
    expect(
      getRetrospectiveState("conv-elsewhere")?.lastProcessedCreatedAt,
    ).toBeNull();
    expect(getRetrospectiveState("conv-missing")).toBeNull();
  });

  test("an empty row list is a no-op", async () => {
    insertLegacyState("conv-a", "reply-1");

    await preserveRetrospectiveCursorTimestamps("conv-a", []);

    expect(getRetrospectiveState("conv-a")?.lastProcessedCreatedAt).toBeNull();
  });
});
