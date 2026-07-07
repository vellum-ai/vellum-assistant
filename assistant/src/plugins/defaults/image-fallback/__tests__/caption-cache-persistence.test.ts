/**
 * Tests for the caption cache's durable layer: the `image_caption_cache`
 * table (migration 321) behind the in-memory LRU.
 *
 * The DB is mocked to an in-memory SQLite handle, with a breakable switch to
 * exercise the fail-open paths. Read-through is verified by seeding rows
 * directly in SQL — a hash the in-memory layer has never seen resolving to a
 * caption proves the lookup came from the table, which is the restart
 * scenario (fresh process, warm table).
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, mock, test } from "bun:test";

const testSqlite = new Database(":memory:");
let dbBroken = false;

mock.module("../../../../persistence/db-connection.js", () => ({
  getDb: () => ({}),
  getSqliteFrom: () => {
    if (dbBroken) {
      throw new Error("db unavailable");
    }
    return testSqlite;
  },
}));

const { migrateCreateImageCaptionCache } =
  await import("../../../../persistence/migrations/321-create-image-caption-cache.js");
const {
  getCachedCaption,
  imageHash,
  resetCaptionCacheForTests,
  setCachedCaption,
} = await import("../src/caption-cache.js");

migrateCreateImageCaptionCache({} as never);

interface CacheRow {
  image_hash: string;
  caption: string;
  created_at: number;
  last_used_at: number;
}

function rowFor(hash: string): CacheRow | null {
  return testSqlite
    .query(`SELECT * FROM image_caption_cache WHERE image_hash = ?`)
    .get(hash) as CacheRow | null;
}

function rowCount(): number {
  const row = testSqlite
    .query(`SELECT COUNT(*) AS n FROM image_caption_cache`)
    .get() as { n: number };
  return row.n;
}

function insertRow(hash: string, caption: string, lastUsedAt: number): void {
  testSqlite
    .query(
      `INSERT INTO image_caption_cache (image_hash, caption, created_at, last_used_at) VALUES (?, ?, ?, ?)`,
    )
    .run(hash, caption, lastUsedAt, lastUsedAt);
}

beforeEach(() => {
  dbBroken = false;
  resetCaptionCacheForTests();
});

describe("migration 321", () => {
  test("creates the expected schema and is idempotent", () => {
    // Re-running must not throw (IF NOT EXISTS).
    migrateCreateImageCaptionCache({} as never);

    const columns = testSqlite
      .query(`PRAGMA table_info(image_caption_cache)`)
      .all() as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>;
    const byName = new Map(columns.map((c) => [c.name, c]));
    expect(byName.get("image_hash")?.pk).toBe(1);
    expect(byName.get("caption")?.notnull).toBe(1);
    expect(byName.get("created_at")?.notnull).toBe(1);
    expect(byName.get("last_used_at")?.notnull).toBe(1);

    const indexes = testSqlite
      .query(`PRAGMA index_list(image_caption_cache)`)
      .all() as Array<{ name: string }>;
    expect(indexes.map((i) => i.name)).toContain(
      "idx_image_caption_cache_last_used",
    );
  });
});

describe("caption cache durable layer", () => {
  test("setCachedCaption writes through to the table", () => {
    const hash = imageHash("some-image-data");
    setCachedCaption(hash, "A chart.");
    const row = rowFor(hash);
    expect(row?.caption).toBe("A chart.");
  });

  test("getCachedCaption reads a row the in-memory layer has never seen (restart scenario)", () => {
    const hash = imageHash("persisted-before-restart");
    insertRow(hash, "A screenshot of the login page.", 1_000);
    expect(getCachedCaption(hash)).toBe("A screenshot of the login page.");
  });

  test("a DB read-through hit bumps last_used_at", () => {
    const hash = imageHash("stale-row");
    insertRow(hash, "An old caption.", 1_000);
    getCachedCaption(hash);
    expect(rowFor(hash)!.last_used_at).toBeGreaterThan(1_000);
  });

  test("a read-through hit is promoted to the in-memory layer", () => {
    const hash = imageHash("promoted-row");
    insertRow(hash, "A promoted caption.", 1_000);
    expect(getCachedCaption(hash)).toBe("A promoted caption.");
    // Break the DB — the second lookup must come from memory.
    dbBroken = true;
    expect(getCachedCaption(hash)).toBe("A promoted caption.");
  });

  test("write eviction keeps the most recently used rows within the cap", () => {
    for (let i = 0; i < 2_000; i++) {
      insertRow(`hash-${i}`, `caption ${i}`, i + 1);
    }
    const newestHash = imageHash("one-over-the-cap");
    setCachedCaption(newestHash, "The newest caption.");
    expect(rowCount()).toBe(2_000);
    expect(rowFor(newestHash)?.caption).toBe("The newest caption.");
    // The least-recently-used row is the one evicted.
    expect(rowFor("hash-0")).toBeNull();
    expect(rowFor("hash-1")).not.toBeNull();
  });

  test("upsert refreshes an existing row instead of duplicating it", () => {
    const hash = imageHash("upserted-image");
    setCachedCaption(hash, "First caption.");
    setCachedCaption(hash, "Second caption.");
    expect(rowFor(hash)?.caption).toBe("Second caption.");
    expect(rowCount()).toBe(1);
  });

  test("fails open when the DB is unavailable: reads miss, writes don't throw, memory still works", () => {
    dbBroken = true;
    const hash = imageHash("db-less-image");
    expect(getCachedCaption(hash)).toBeUndefined();
    expect(() => setCachedCaption(hash, "Memory-only caption.")).not.toThrow();
    expect(getCachedCaption(hash)).toBe("Memory-only caption.");
    // Nothing reached the table.
    dbBroken = false;
    expect(rowFor(hash)).toBeNull();
  });
});
