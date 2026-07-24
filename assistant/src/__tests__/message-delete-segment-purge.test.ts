/**
 * Message-scoped segment/embedding purge. Deleting a single message (its
 * conversation lives on) must remove that message's memory_segments and their
 * embeddings on the memory connection, while a sibling message's rows survive.
 * The conversation-keyed purge does not apply here, so this explicit delete is
 * the sole cleanup for message-scoped rows — there is no orphan-sweep backstop.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { setConfig } from "./helpers/set-config.js";

// Disable memory so addMessage does not index into the real pipeline; the
// message-delete cleanup under test is not gated on the plugin being enabled.
setConfig("memory", { enabled: false, v2: { enabled: false } });

import {
  addMessage,
  createConversation,
  deleteMessageById,
} from "../persistence/conversation-crud.js";
import { getMemorySqlite, getSqlite } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";

await initializeDb();

function seedSegment(
  segmentId: string,
  messageId: string,
  conversationId: string,
): void {
  const mem = getMemorySqlite()!;
  mem.run(
    `INSERT INTO memory_segments
       (id, message_id, conversation_id, role, segment_index, text,
        token_estimate, created_at, updated_at)
     VALUES ('${segmentId}', '${messageId}', '${conversationId}', 'user', 0,
             'text', 1, 0, 0)`,
  );
  mem.run(
    `INSERT INTO memory_embeddings
       (id, target_type, target_id, provider, model, dimensions,
        created_at, updated_at)
     VALUES ('emb-${segmentId}', 'segment', '${segmentId}', 'p', 'm', 3, 0, 0)`,
  );
}

function memoryRows(table: string): string[] {
  return (
    getMemorySqlite()!
      .query(`SELECT id FROM ${table} ORDER BY id`)
      .all() as Array<{ id: string }>
  ).map((r) => r.id);
}

beforeEach(() => {
  const sqlite = getSqlite();
  getMemorySqlite()!.run("DELETE FROM memory_embeddings");
  getMemorySqlite()!.run("DELETE FROM memory_segments");
  sqlite.run("DELETE FROM messages");
  sqlite.run("DELETE FROM conversations");
});

describe("deleteMessageById segment purge", () => {
  test("purges the deleted message's segments and embeddings, leaving a sibling's intact", async () => {
    const conv = createConversation("conv");
    const msgA = await addMessage(conv.id, "user", "a", { skipIndexing: true });
    const msgB = await addMessage(conv.id, "user", "b", { skipIndexing: true });
    seedSegment("seg-a", msgA.id, conv.id);
    seedSegment("seg-b", msgB.id, conv.id);

    const result = deleteMessageById(msgA.id);

    // The deleted message's ids are returned for the caller's Qdrant purge.
    expect(result.segmentIds).toEqual(["seg-a"]);
    // Its segment and embedding are gone; the sibling message's survive.
    expect(memoryRows("memory_segments")).toEqual(["seg-b"]);
    expect(memoryRows("memory_embeddings")).toEqual(["emb-seg-b"]);
    // The conversation and the sibling message live on.
    expect(
      getSqlite().query("SELECT COUNT(*) AS c FROM conversations").get(),
    ).toEqual({ c: 1 });
    expect(getSqlite().query("SELECT id FROM messages").all()).toEqual([
      { id: msgB.id },
    ]);
  });

  test("returns no ids and no-ops when the message has no segments", async () => {
    const conv = createConversation("conv");
    const msg = await addMessage(conv.id, "user", "no segments", {
      skipIndexing: true,
    });

    const result = deleteMessageById(msg.id);

    expect(result.segmentIds).toEqual([]);
    expect(memoryRows("memory_segments")).toEqual([]);
  });
});
