import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = mkdtempSync(join(tmpdir(), "conv-wipe-test-"));

mock.module("../util/platform.js", () => ({
  getDataDir: () => testDir,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getPidPath: () => join(testDir, "test.pid"),
  getDbPath: () => join(testDir, "test.db"),
  getLogPath: () => join(testDir, "test.log"),
  ensureDataDir: () => {},
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import {
  addMessage,
  createConversation,
  deleteConversation,
  getConversation,
  getMessages,
  wipeConversation,
} from "../memory/conversation-crud.js";
import { getDb, initializeDb, resetDb } from "../memory/db.js";
import { enqueueMemoryJob } from "../memory/jobs-store.js";

// Initialize db once before all tests
initializeDb();

afterAll(() => {
  resetDb();
  try {
    rmSync(testDir, { recursive: true });
  } catch {
    /* best effort */
  }
});

describe("wipeConversation", () => {
  beforeEach(() => {
    const db = getDb();
    db.run(`DELETE FROM memory_item_sources`);
    db.run(`DELETE FROM memory_segments`);
    db.run(`DELETE FROM memory_items`);
    db.run(`DELETE FROM memory_summaries`);
    db.run(`DELETE FROM memory_embeddings`);
    db.run(`DELETE FROM memory_jobs`);
    db.run(`DELETE FROM tool_invocations`);
    db.run(`DELETE FROM llm_request_logs`);
    db.run(`DELETE FROM messages`);
    db.run(`DELETE FROM conversations`);
  });

  test("wipes conversation and all messages", async () => {
    const conv = createConversation("test");
    await addMessage(conv.id, "user", "first message");
    await addMessage(conv.id, "assistant", "second message");
    await addMessage(conv.id, "user", "third message");

    wipeConversation(conv.id);

    expect(getConversation(conv.id)).toBeNull();
    expect(getMessages(conv.id)).toEqual([]);
  });

  test("restores explicitly superseded memory items", async () => {
    const convA = createConversation("conversation A");
    const msgA = await addMessage(convA.id, "user", "I like blue");

    const convB = createConversation("conversation B");
    const msgB = await addMessage(convB.id, "user", "I like red");

    const db = getDb();
    const now = Date.now();

    // Insert itemA: active preference about color
    db.run(
      `INSERT INTO memory_items (id, status, kind, subject, statement, confidence, fingerprint, scope_id, first_seen_at, last_seen_at)
       VALUES ('itemA', 'active', 'preference', 'color', 'likes blue', 0.8, 'fp-a', 'default', ${now}, ${now})`,
    );

    // Insert itemB: active preference about color, supersedes itemA
    db.run(
      `INSERT INTO memory_items (id, status, kind, subject, statement, confidence, fingerprint, scope_id, supersedes, first_seen_at, last_seen_at)
       VALUES ('itemB', 'active', 'preference', 'color', 'likes red', 0.9, 'fp-b', 'default', 'itemA', ${now}, ${now})`,
    );

    // Mark itemA as superseded by itemB
    db.run(
      `UPDATE memory_items SET status = 'superseded', superseded_by = 'itemB' WHERE id = 'itemA'`,
    );

    // Link itemA to convA's message, itemB to convB's message
    db.run(
      `INSERT INTO memory_item_sources (memory_item_id, message_id, created_at) VALUES ('itemA', '${msgA.id}', ${now})`,
    );
    db.run(
      `INSERT INTO memory_item_sources (memory_item_id, message_id, created_at) VALUES ('itemB', '${msgB.id}', ${now})`,
    );

    const result = wipeConversation(convB.id);

    // itemA should be restored to active with superseded_by cleared
    const raw = (
      getDb() as unknown as {
        $client: import("bun:sqlite").Database;
      }
    ).$client;
    const itemARow = raw
      .query(
        "SELECT status, superseded_by FROM memory_items WHERE id = 'itemA'",
      )
      .get() as { status: string; superseded_by: string | null } | null;
    expect(itemARow).not.toBeNull();
    expect(itemARow!.status).toBe("active");
    expect(itemARow!.superseded_by).toBeNull();

    // itemB should no longer exist (orphaned and deleted by deleteConversation)
    const itemBRow = (
      getDb() as unknown as {
        $client: import("bun:sqlite").Database;
      }
    ).$client
      .query("SELECT * FROM memory_items WHERE id = 'itemB'")
      .get();
    expect(itemBRow).toBeNull();

    expect(result.unsupersededItemIds).toContain("itemA");
  });

  test("does not restore superseded items when superseding item has other sources", async () => {
    const convA = createConversation("conversation A");
    const msgA = await addMessage(convA.id, "user", "I like red in A");

    const convB = createConversation("conversation B");
    const msgB = await addMessage(convB.id, "user", "I like red in B");

    const db = getDb();
    const now = Date.now();

    // Insert itemOld (will be superseded)
    db.run(
      `INSERT INTO memory_items (id, status, kind, subject, statement, confidence, fingerprint, scope_id, first_seen_at, last_seen_at)
       VALUES ('itemOld', 'active', 'preference', 'color', 'likes blue', 0.8, 'fp-old', 'default', ${now}, ${now})`,
    );

    // Insert itemNew (supersedes itemOld)
    db.run(
      `INSERT INTO memory_items (id, status, kind, subject, statement, confidence, fingerprint, scope_id, supersedes, first_seen_at, last_seen_at)
       VALUES ('itemNew', 'active', 'preference', 'color', 'likes red', 0.9, 'fp-new', 'default', 'itemOld', ${now}, ${now})`,
    );

    // Mark itemOld as superseded
    db.run(
      `UPDATE memory_items SET status = 'superseded', superseded_by = 'itemNew' WHERE id = 'itemOld'`,
    );

    // Link itemNew to BOTH conversations
    db.run(
      `INSERT INTO memory_item_sources (memory_item_id, message_id, created_at) VALUES ('itemNew', '${msgA.id}', ${now})`,
    );
    db.run(
      `INSERT INTO memory_item_sources (memory_item_id, message_id, created_at) VALUES ('itemNew', '${msgB.id}', ${now})`,
    );

    wipeConversation(convA.id);

    const raw = (
      getDb() as unknown as {
        $client: import("bun:sqlite").Database;
      }
    ).$client;

    // itemOld should still be superseded because itemNew has another source (convB)
    const itemOldRow = raw
      .query("SELECT status FROM memory_items WHERE id = 'itemOld'")
      .get() as { status: string } | null;
    expect(itemOldRow).not.toBeNull();
    expect(itemOldRow!.status).toBe("superseded");

    // itemNew should still exist (has source from convB)
    const itemNewRow = raw
      .query("SELECT * FROM memory_items WHERE id = 'itemNew'")
      .get();
    expect(itemNewRow).not.toBeNull();
  });

  test("restores orphaned subject-match superseded items", async () => {
    const convB = createConversation("conversation B");
    const msgB = await addMessage(convB.id, "user", "I use vim");

    const db = getDb();
    const now = Date.now();

    // Insert itemOld: superseded with no superseded_by link
    db.run(
      `INSERT INTO memory_items (id, status, kind, subject, statement, confidence, fingerprint, scope_id, first_seen_at, last_seen_at)
       VALUES ('itemOld', 'superseded', 'preference', 'editor', 'uses emacs', 0.7, 'fp-old', 'default', ${now}, ${now})`,
    );

    // Insert itemNew: active, same kind/subject/scope_id
    db.run(
      `INSERT INTO memory_items (id, status, kind, subject, statement, confidence, fingerprint, scope_id, first_seen_at, last_seen_at)
       VALUES ('itemNew', 'active', 'preference', 'editor', 'uses vim', 0.9, 'fp-new', 'default', ${now}, ${now})`,
    );

    // Link itemNew to convB's message
    db.run(
      `INSERT INTO memory_item_sources (memory_item_id, message_id, created_at) VALUES ('itemNew', '${msgB.id}', ${now})`,
    );

    wipeConversation(convB.id);

    const raw = (
      getDb() as unknown as {
        $client: import("bun:sqlite").Database;
      }
    ).$client;

    // itemOld should now be active (restored as orphaned subject-match superseded item)
    const itemOldRow = raw
      .query("SELECT status FROM memory_items WHERE id = 'itemOld'")
      .get() as { status: string } | null;
    expect(itemOldRow).not.toBeNull();
    expect(itemOldRow!.status).toBe("active");
  });

  test("does not restore superseded items from unrelated conversations", async () => {
    // convA has an item that superseded an older item — convA was previously
    // deleted via regular deleteConversation, leaving the old item superseded
    // with superseded_by = NULL. When we later wipe convB, Step F should NOT
    // restore that unrelated item.
    const convA = createConversation("conversation A");
    const _msgA = await addMessage(convA.id, "user", "I use dark theme");

    const convB = createConversation("conversation B");
    const msgB = await addMessage(convB.id, "user", "I use vim");

    const db = getDb();
    const now = Date.now();

    // unrelatedOld: superseded item from an old conversation (e.g. "uses light theme")
    // Its superseder was deleted in a prior deleteConversation, leaving
    // superseded_by = NULL.
    db.run(
      `INSERT INTO memory_items (id, status, kind, subject, statement, confidence, fingerprint, scope_id, first_seen_at, last_seen_at)
       VALUES ('unrelatedOld', 'superseded', 'preference', 'theme', 'uses light theme', 0.7, 'fp-unrelated', 'default', ${now}, ${now})`,
    );

    // convA's active item that superseded unrelatedOld — we simulate the
    // case where convA was already deleted, leaving unrelatedOld with
    // superseded_by = NULL and no active replacement.
    // (We don't actually insert the superseder — just leave unrelatedOld
    // as a superseded item with no superseded_by and no active match.)

    // convB's items — itemOld is superseded by itemNew (subject: editor)
    db.run(
      `INSERT INTO memory_items (id, status, kind, subject, statement, confidence, fingerprint, scope_id, first_seen_at, last_seen_at)
       VALUES ('editorOld', 'superseded', 'preference', 'editor', 'uses emacs', 0.7, 'fp-editor-old', 'default', ${now}, ${now})`,
    );
    db.run(
      `INSERT INTO memory_items (id, status, kind, subject, statement, confidence, fingerprint, scope_id, first_seen_at, last_seen_at)
       VALUES ('editorNew', 'active', 'preference', 'editor', 'uses vim', 0.9, 'fp-editor-new', 'default', ${now}, ${now})`,
    );
    db.run(
      `INSERT INTO memory_item_sources (memory_item_id, message_id, created_at) VALUES ('editorNew', '${msgB.id}', ${now})`,
    );

    const result = wipeConversation(convB.id);

    const raw = (
      getDb() as unknown as {
        $client: import("bun:sqlite").Database;
      }
    ).$client;

    // editorOld SHOULD be restored (its kind+subject matches an orphaned item from convB)
    const editorOldRow = raw
      .query("SELECT status FROM memory_items WHERE id = 'editorOld'")
      .get() as { status: string } | null;
    expect(editorOldRow).not.toBeNull();
    expect(editorOldRow!.status).toBe("active");

    // unrelatedOld should NOT be restored — it was superseded by a different
    // conversation's item (theme, not editor) and has nothing to do with convB
    const unrelatedOldRow = raw
      .query("SELECT status FROM memory_items WHERE id = 'unrelatedOld'")
      .get() as { status: string } | null;
    expect(unrelatedOldRow).not.toBeNull();
    expect(unrelatedOldRow!.status).toBe("superseded");

    // Only editorOld should be in the unsuperseded list, not unrelatedOld
    expect(result.unsupersededItemIds).toContain("editorOld");
    expect(result.unsupersededItemIds).not.toContain("unrelatedOld");
  });

  test("deletes conversation summaries", async () => {
    const conv = createConversation("test");
    await addMessage(conv.id, "user", "hello");

    const now = Date.now();

    const raw = (
      getDb() as unknown as {
        $client: import("bun:sqlite").Database;
      }
    ).$client;

    // Insert a conversation-scoped summary
    raw
      .query(
        `INSERT INTO memory_summaries (id, scope, scope_key, summary, token_estimate, version, scope_id, start_at, end_at, created_at, updated_at)
         VALUES ('sum-1', 'conversation', ?, 'test summary', 100, 1, 'default', ?, ?, ?, ?)`,
      )
      .run(conv.id, now, now, now, now);

    // Insert a corresponding embedding
    raw
      .query(
        `INSERT INTO memory_embeddings (id, target_type, target_id, provider, model, dimensions, created_at, updated_at)
         VALUES ('emb-sum-1', 'summary', 'sum-1', 'test', 'test', 384, ?, ?)`,
      )
      .run(now, now);

    const result = wipeConversation(conv.id);

    // Summary should be deleted
    const summaryRow = raw
      .query("SELECT * FROM memory_summaries WHERE id = 'sum-1'")
      .get();
    expect(summaryRow).toBeNull();

    // Embedding should be deleted
    const embeddingRow = raw
      .query("SELECT * FROM memory_embeddings WHERE id = 'emb-sum-1'")
      .get();
    expect(embeddingRow).toBeNull();

    expect(result.deletedSummaryIds).toContain("sum-1");
  });

  test("cancels pending memory jobs", async () => {
    const conv = createConversation("test");
    const msg = await addMessage(conv.id, "user", "hello", undefined, {
      skipIndexing: true,
    });

    // Clear any jobs that might have been created by prior operations
    const db = getDb();
    db.run(`DELETE FROM memory_jobs`);

    enqueueMemoryJob("extract_items", { messageId: msg.id });
    enqueueMemoryJob("build_conversation_summary", {
      conversationId: conv.id,
    });

    const result = wipeConversation(conv.id);

    const raw = (
      getDb() as unknown as {
        $client: import("bun:sqlite").Database;
      }
    ).$client;

    // Both jobs should be failed with conversation_wiped error
    const jobs = raw
      .query("SELECT status, last_error FROM memory_jobs")
      .all() as Array<{ status: string; last_error: string | null }>;

    for (const job of jobs) {
      // Skip embed_item jobs enqueued by wipeConversation's unsupersede logic
      if (job.status === "pending") continue;
      expect(job.status).toBe("failed");
      expect(job.last_error).toContain("conversation_wiped");
    }

    expect(result.cancelledJobCount).toBeGreaterThanOrEqual(2);
  });

  test("wipe of empty conversation succeeds", () => {
    const conv = createConversation("empty");

    const result = wipeConversation(conv.id);

    expect(getConversation(conv.id)).toBeNull();
    expect(result.segmentIds).toEqual([]);
    expect(result.orphanedItemIds).toEqual([]);
    expect(result.unsupersededItemIds).toEqual([]);
    expect(result.deletedSummaryIds).toEqual([]);
    expect(result.cancelledJobCount).toBe(0);
  });

  test("does not affect other conversations", async () => {
    const convA = createConversation("conversation A");
    await addMessage(convA.id, "user", "message in A");

    const convB = createConversation("conversation B");
    const msgB = await addMessage(convB.id, "user", "message in B");

    const db = getDb();
    const now = Date.now();

    // Insert a memory item sourced from convB's message
    db.run(
      `INSERT INTO memory_items (id, status, kind, subject, statement, confidence, fingerprint, scope_id, first_seen_at, last_seen_at)
       VALUES ('itemB', 'active', 'fact', 'test', 'test fact', 0.8, 'fp-b', 'default', ${now}, ${now})`,
    );
    db.run(
      `INSERT INTO memory_item_sources (memory_item_id, message_id, created_at) VALUES ('itemB', '${msgB.id}', ${now})`,
    );

    wipeConversation(convA.id);

    // convB should still exist
    expect(getConversation(convB.id)).not.toBeNull();
    expect(getMessages(convB.id)).toHaveLength(1);

    // convB's memory item should still exist
    const raw = (
      getDb() as unknown as {
        $client: import("bun:sqlite").Database;
      }
    ).$client;
    const itemBRow = raw
      .query("SELECT * FROM memory_items WHERE id = 'itemB'")
      .get();
    expect(itemBRow).not.toBeNull();
  });
});

describe("deleteConversation — private scope cleanup", () => {
  beforeEach(() => {
    const db = getDb();
    db.run(`DELETE FROM conversation_starters`);
    db.run(`DELETE FROM memory_item_sources`);
    db.run(`DELETE FROM memory_segments`);
    db.run(`DELETE FROM memory_items`);
    db.run(`DELETE FROM memory_summaries`);
    db.run(`DELETE FROM memory_embeddings`);
    db.run(`DELETE FROM memory_jobs`);
    db.run(`DELETE FROM tool_invocations`);
    db.run(`DELETE FROM llm_request_logs`);
    db.run(`DELETE FROM messages`);
    db.run(`DELETE FROM conversations`);
  });

  test("sourceless items cleaned up", () => {
    const conv = createConversation({ conversationType: "private" });
    const scopeId = conv.memoryScopeId;
    const now = Date.now();

    const raw = (
      getDb() as unknown as {
        $client: import("bun:sqlite").Database;
      }
    ).$client;

    // Insert a memory item with matching scopeId but no memory_item_sources
    raw
      .query(
        `INSERT INTO memory_items (id, status, kind, subject, statement, confidence, fingerprint, scope_id, first_seen_at, last_seen_at)
         VALUES ('priv-item-1', 'active', 'fact', 'test', 'test fact', 0.8, 'fp-priv-1', ?, ?, ?)`,
      )
      .run(scopeId, now, now);

    const result = deleteConversation(conv.id);

    // Item should be gone
    const itemRow = raw
      .query("SELECT * FROM memory_items WHERE id = 'priv-item-1'")
      .get();
    expect(itemRow).toBeNull();

    // Its ID should be in orphanedItemIds
    expect(result.orphanedItemIds).toContain("priv-item-1");
  });

  test("summaries cleaned up", () => {
    const conv = createConversation({ conversationType: "private" });
    const scopeId = conv.memoryScopeId;
    const now = Date.now();

    const raw = (
      getDb() as unknown as {
        $client: import("bun:sqlite").Database;
      }
    ).$client;

    // Insert a memory summary with matching scopeId
    raw
      .query(
        `INSERT INTO memory_summaries (id, scope, scope_key, summary, token_estimate, version, scope_id, start_at, end_at, created_at, updated_at)
         VALUES ('priv-sum-1', 'global', 'all', 'private summary', 100, 1, ?, ?, ?, ?, ?)`,
      )
      .run(scopeId, now, now, now, now);

    const result = deleteConversation(conv.id);

    // Summary should be gone
    const summaryRow = raw
      .query("SELECT * FROM memory_summaries WHERE id = 'priv-sum-1'")
      .get();
    expect(summaryRow).toBeNull();

    // Its ID should be in deletedSummaryIds
    expect(result.deletedSummaryIds).toContain("priv-sum-1");
  });

  test("standard conversations unaffected", async () => {
    const conv = createConversation("standard test");
    const now = Date.now();

    const raw = (
      getDb() as unknown as {
        $client: import("bun:sqlite").Database;
      }
    ).$client;

    // Insert items with scopeId = "default"
    raw
      .query(
        `INSERT INTO memory_items (id, status, kind, subject, statement, confidence, fingerprint, scope_id, first_seen_at, last_seen_at)
         VALUES ('default-item-1', 'active', 'fact', 'test', 'test fact', 0.8, 'fp-default', 'default', ?, ?)`,
      )
      .run(now, now);

    deleteConversation(conv.id);

    // Default-scope items should still exist
    const itemRow = raw
      .query("SELECT * FROM memory_items WHERE id = 'default-item-1'")
      .get();
    expect(itemRow).not.toBeNull();
  });

  test("embeddings cleaned up", () => {
    const conv = createConversation({ conversationType: "private" });
    const scopeId = conv.memoryScopeId;
    const now = Date.now();

    const raw = (
      getDb() as unknown as {
        $client: import("bun:sqlite").Database;
      }
    ).$client;

    // Insert a memory item with matching scopeId
    raw
      .query(
        `INSERT INTO memory_items (id, status, kind, subject, statement, confidence, fingerprint, scope_id, first_seen_at, last_seen_at)
         VALUES ('priv-item-emb', 'active', 'fact', 'test', 'test fact', 0.8, 'fp-priv-emb', ?, ?, ?)`,
      )
      .run(scopeId, now, now);

    // Insert a corresponding embedding
    raw
      .query(
        `INSERT INTO memory_embeddings (id, target_type, target_id, provider, model, dimensions, created_at, updated_at)
         VALUES ('emb-priv-item', 'item', 'priv-item-emb', 'test', 'test', 384, ?, ?)`,
      )
      .run(now, now);

    deleteConversation(conv.id);

    // Both item and embedding should be deleted
    const itemRow = raw
      .query("SELECT * FROM memory_items WHERE id = 'priv-item-emb'")
      .get();
    expect(itemRow).toBeNull();

    const embeddingRow = raw
      .query("SELECT * FROM memory_embeddings WHERE id = 'emb-priv-item'")
      .get();
    expect(embeddingRow).toBeNull();
  });

  test("conversationStarters cleaned up", () => {
    const conv = createConversation({ conversationType: "private" });
    const scopeId = conv.memoryScopeId;
    const now = Date.now();

    const raw = (
      getDb() as unknown as {
        $client: import("bun:sqlite").Database;
      }
    ).$client;

    // Insert a conversation_starters row with the private scopeId
    raw
      .query(
        `INSERT INTO conversation_starters (id, label, prompt, generation_batch, scope_id, card_type, created_at)
         VALUES ('starter-1', 'Test starter', 'Tell me about tests', 1, ?, 'chip', ?)`,
      )
      .run(scopeId, now);

    // Also insert a default-scope starter that should NOT be deleted
    raw
      .query(
        `INSERT INTO conversation_starters (id, label, prompt, generation_batch, scope_id, card_type, created_at)
         VALUES ('starter-default', 'Default starter', 'Hello', 1, 'default', 'chip', ?)`,
      )
      .run(now);

    deleteConversation(conv.id);

    // Private-scope starter should be gone
    const starterRow = raw
      .query("SELECT * FROM conversation_starters WHERE id = 'starter-1'")
      .get();
    expect(starterRow).toBeNull();

    // Default-scope starter should still exist
    const defaultStarterRow = raw
      .query("SELECT * FROM conversation_starters WHERE id = 'starter-default'")
      .get();
    expect(defaultStarterRow).not.toBeNull();
  });

  test("no duplicate IDs", async () => {
    const conv = createConversation({ conversationType: "private" });
    const scopeId = conv.memoryScopeId;
    const msg = await addMessage(conv.id, "user", "hello");
    const now = Date.now();

    const raw = (
      getDb() as unknown as {
        $client: import("bun:sqlite").Database;
      }
    ).$client;

    // Insert a memory item with the private scopeId AND a source linking to the message
    raw
      .query(
        `INSERT INTO memory_items (id, status, kind, subject, statement, confidence, fingerprint, scope_id, first_seen_at, last_seen_at)
         VALUES ('priv-item-dup', 'active', 'fact', 'test', 'test fact', 0.8, 'fp-priv-dup', ?, ?, ?)`,
      )
      .run(scopeId, now, now);

    raw
      .query(
        `INSERT INTO memory_item_sources (memory_item_id, message_id, created_at) VALUES ('priv-item-dup', ?, ?)`,
      )
      .run(msg.id, now);

    const result = deleteConversation(conv.id);

    // The item ID should appear exactly once in orphanedItemIds (caught by
    // source-based cleanup, not double-counted by scope sweep).
    const count = result.orphanedItemIds.filter(
      (id) => id === "priv-item-dup",
    ).length;
    expect(count).toBe(1);
  });
});
