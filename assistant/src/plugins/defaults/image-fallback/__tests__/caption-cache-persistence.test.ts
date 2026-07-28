/**
 * Tests for the caption cache's durable layer: the plugin-owned
 * `caption-cache.sqlite` file the `init` hook opens in the plugin's storage
 * dir.
 *
 * Assertions read the store's file through a separate SQLite connection.
 * Read-through is verified by seeding rows directly in SQL — a hash the
 * in-memory layer has never seen resolving to a caption proves the lookup
 * came from the durable layer, which is the restart scenario (fresh process,
 * warm file).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import {
  closeCaptionStore,
  deleteConversationCaptions,
  getCachedCaption,
  imageHash,
  initCaptionStore,
  resetCaptionCacheForTests,
  setCachedCaption,
} from "../src/caption-cache.js";

const STORAGE_DIR = mkdtempSync(join(tmpdir(), "caption-cache-test-"));
const DB_PATH = join(STORAGE_DIR, "caption-cache.sqlite");

initCaptionStore(STORAGE_DIR);

/** Separate read/seed connection onto the store's file. */
const inspector = new Database(DB_PATH);

interface CacheRow {
  image_hash: string;
  conversation_id: string;
  caption: string;
  created_at: number;
  last_used_at: number;
}

function rowsFor(hash: string): CacheRow[] {
  return inspector
    .query(`SELECT * FROM image_captions WHERE image_hash = ?`)
    .all(hash) as CacheRow[];
}

function rowCount(): number {
  const row = inspector
    .query(`SELECT COUNT(*) AS n FROM image_captions`)
    .get() as { n: number };
  return row.n;
}

function insertRow(
  hash: string,
  conversationId: string,
  caption: string,
  lastUsedAt: number,
): void {
  inspector
    .query(
      `INSERT INTO image_captions (image_hash, conversation_id, caption, created_at, last_used_at) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(hash, conversationId, caption, lastUsedAt, lastUsedAt);
}

beforeEach(() => {
  // Re-open in case a test closed the store to exercise fail-open.
  initCaptionStore(STORAGE_DIR);
  resetCaptionCacheForTests();
});

afterAll(() => {
  inspector.close();
  closeCaptionStore();
  rmSync(STORAGE_DIR, { recursive: true, force: true });
});

describe("caption store init", () => {
  test("creates the expected schema and is idempotent", () => {
    // Re-running must not throw and must keep the existing file usable.
    initCaptionStore(STORAGE_DIR);

    const columns = inspector
      .query(`PRAGMA table_info(image_captions)`)
      .all() as Array<{ name: string; notnull: number; pk: number }>;
    const byName = new Map(columns.map((c) => [c.name, c]));
    expect(byName.get("image_hash")?.pk).toBe(1);
    expect(byName.get("conversation_id")?.pk).toBe(2);
    expect(byName.get("caption")?.notnull).toBe(1);
    expect(byName.get("created_at")?.notnull).toBe(1);
    expect(byName.get("last_used_at")?.notnull).toBe(1);

    const indexes = inspector
      .query(`PRAGMA index_list(image_captions)`)
      .all() as Array<{ name: string }>;
    const names = indexes.map((i) => i.name);
    expect(names).toContain("idx_image_captions_last_used");
    expect(names).toContain("idx_image_captions_conversation");
  });
});

describe("caption cache durable layer", () => {
  test("setCachedCaption writes through with the conversation association", () => {
    const hash = imageHash("some-image-data");
    setCachedCaption(hash, "conv-1", "A chart.");
    const rows = rowsFor(hash);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.caption).toBe("A chart.");
    expect(rows[0]!.conversation_id).toBe("conv-1");
  });

  test("getCachedCaption reads a row the in-memory layer has never seen (restart scenario)", () => {
    const hash = imageHash("persisted-before-restart");
    insertRow(hash, "conv-1", "A screenshot of the login page.", 1_000);
    expect(getCachedCaption(hash, "conv-1")).toBe(
      "A screenshot of the login page.",
    );
  });

  test("a hit from another conversation records that conversation's association", () => {
    const hash = imageHash("shared-image");
    setCachedCaption(hash, "conv-1", "A shared diagram.");
    expect(getCachedCaption(hash, "conv-2")).toBe("A shared diagram.");
    const conversations = rowsFor(hash)
      .map((r) => r.conversation_id)
      .sort();
    expect(conversations).toEqual(["conv-1", "conv-2"]);
  });

  test("a durable-layer hit bumps last_used_at", () => {
    const hash = imageHash("stale-row");
    insertRow(hash, "conv-1", "An old caption.", 1_000);
    getCachedCaption(hash, "conv-1");
    expect(rowsFor(hash)[0]!.last_used_at).toBeGreaterThan(1_000);
  });

  test("a durable-layer hit is promoted to the in-memory layer", () => {
    const hash = imageHash("promoted-row");
    insertRow(hash, "conv-1", "A promoted caption.", 1_000);
    expect(getCachedCaption(hash, "conv-1")).toBe("A promoted caption.");
    // Close the store — the second lookup must come from memory.
    closeCaptionStore();
    expect(getCachedCaption(hash, "conv-1")).toBe("A promoted caption.");
  });

  test("write eviction keeps the most recently used rows within the cap", () => {
    // Seed in one transaction — 2,000 autocommit inserts fsync individually
    // and time the test out on slow CI disks.
    inspector.transaction(() => {
      for (let i = 0; i < 2_000; i++) {
        insertRow(`hash-${i}`, "conv-1", `caption ${i}`, i + 1);
      }
    })();
    const newestHash = imageHash("one-over-the-cap");
    setCachedCaption(newestHash, "conv-1", "The newest caption.");
    expect(rowCount()).toBe(2_000);
    expect(rowsFor(newestHash)).toHaveLength(1);
    // The least-recently-used row is the one evicted.
    expect(rowsFor("hash-0")).toHaveLength(0);
    expect(rowsFor("hash-1")).toHaveLength(1);
  });

  test("upsert refreshes an existing row instead of duplicating it", () => {
    const hash = imageHash("upserted-image");
    setCachedCaption(hash, "conv-1", "First caption.");
    setCachedCaption(hash, "conv-1", "Second caption.");
    const rows = rowsFor(hash);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.caption).toBe("Second caption.");
  });

  test("fails open when the store is closed: reads miss, writes don't throw, memory still works", () => {
    closeCaptionStore();
    const hash = imageHash("db-less-image");
    expect(getCachedCaption(hash, "conv-1")).toBeUndefined();
    expect(() =>
      setCachedCaption(hash, "conv-1", "Memory-only caption."),
    ).not.toThrow();
    expect(getCachedCaption(hash, "conv-1")).toBe("Memory-only caption.");
    // Nothing reached the durable layer.
    expect(rowsFor(hash)).toHaveLength(0);
  });
});

describe("conversation-deleted cleanup", () => {
  test("removes exactly the deleted conversation's rows", () => {
    const shared = imageHash("shared-across-conversations");
    const exclusive = imageHash("only-in-deleted-conversation");
    setCachedCaption(shared, "conv-keep", "A shared caption.");
    setCachedCaption(shared, "conv-drop", "A shared caption.");
    setCachedCaption(exclusive, "conv-drop", "An exclusive caption.");

    expect(deleteConversationCaptions("conv-drop")).toBe(2);

    expect(rowsFor(exclusive)).toHaveLength(0);
    const sharedRows = rowsFor(shared);
    expect(sharedRows).toHaveLength(1);
    expect(sharedRows[0]!.conversation_id).toBe("conv-keep");
    // The surviving conversation still resolves the shared caption.
    expect(getCachedCaption(shared, "conv-keep")).toBe("A shared caption.");
  });

  test("drops orphaned hashes from the in-memory layer too", () => {
    const hash = imageHash("memory-resident-image");
    setCachedCaption(hash, "conv-drop", "A doomed caption.");
    deleteConversationCaptions("conv-drop");
    // Close the store: if the caption survived in memory, this would hit.
    closeCaptionStore();
    expect(getCachedCaption(hash, "conv-drop")).toBeUndefined();
  });

  test("is a no-op for a conversation with no rows", () => {
    expect(deleteConversationCaptions("conv-unknown")).toBe(0);
  });
});
