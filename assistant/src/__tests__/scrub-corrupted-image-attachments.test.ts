import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { migrateScrubCorruptedImageAttachments } from "../memory/migrations/206-scrub-corrupted-image-attachments.js";
import * as schema from "../memory/schema.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  sqlite.exec("PRAGMA foreign_keys = OFF");
  return drizzle(sqlite, { schema });
}

type TestDb = ReturnType<typeof createTestDb>;

function getRawSqlite(db: TestDb): Database {
  return (db as unknown as { $client: Database }).$client;
}

function createRequiredTables(raw: Database) {
  raw.exec(/*sql*/ `
    CREATE TABLE memory_checkpoints (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  raw.exec(/*sql*/ `
    CREATE TABLE attachments (
      id TEXT PRIMARY KEY,
      original_filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      kind TEXT NOT NULL,
      data_base64 TEXT NOT NULL DEFAULT '',
      content_hash TEXT,
      thumbnail_base64 TEXT,
      file_path TEXT,
      created_at INTEGER NOT NULL
    )
  `);

  raw.exec(/*sql*/ `
    CREATE TABLE message_attachments (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      attachment_id TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )
  `);
}

// A minimal valid PNG header (8 bytes)
const VALID_PNG_BASE64 = Buffer.from(
  Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]),
).toString("base64");

// HTML error page encoded as base64 (simulating Slack CDN auth failure)
const HTML_ERROR_BASE64 = Buffer.from(
  "<!DOCTYPE html><html><head><title>Sign in</title></head><body>Please sign in</body></html>",
).toString("base64");

// HTML with leading whitespace/BOM
const HTML_WITH_BOM_BASE64 = Buffer.from(
  "\uFEFF  <!DOCTYPE html><html><body>Error</body></html>",
).toString("base64");

const HTML_UPPERCASE_BASE64 = Buffer.from(
  "<HTML><BODY>Error page</BODY></HTML>",
).toString("base64");

describe("migrateScrubCorruptedImageAttachments", () => {
  test("removes corrupted image attachment with HTML data_base64", () => {
    const db = createTestDb();
    const raw = getRawSqlite(db);
    const now = Date.now();

    createRequiredTables(raw);

    // Insert corrupted attachment (HTML stored as image/png)
    raw.exec(/*sql*/ `
      INSERT INTO attachments (id, original_filename, mime_type, size_bytes, kind, data_base64, created_at)
      VALUES ('corrupt-1', 'image.png', 'image/png', 100, 'image', '${HTML_ERROR_BASE64}', ${now})
    `);

    // Insert message_attachments link
    raw.exec(/*sql*/ `
      INSERT INTO message_attachments (id, message_id, attachment_id, position, created_at)
      VALUES ('ma-1', 'msg-1', 'corrupt-1', 0, ${now})
    `);

    migrateScrubCorruptedImageAttachments(db);

    const attachmentCount = raw
      .query(`SELECT COUNT(*) AS count FROM attachments`)
      .get() as { count: number };
    expect(attachmentCount.count).toBe(0);

    const linkCount = raw
      .query(`SELECT COUNT(*) AS count FROM message_attachments`)
      .get() as { count: number };
    expect(linkCount.count).toBe(0);
  });

  test("does NOT remove valid PNG attachment", () => {
    const db = createTestDb();
    const raw = getRawSqlite(db);
    const now = Date.now();

    createRequiredTables(raw);

    // Insert valid PNG attachment
    raw.exec(/*sql*/ `
      INSERT INTO attachments (id, original_filename, mime_type, size_bytes, kind, data_base64, created_at)
      VALUES ('valid-1', 'photo.png', 'image/png', 200, 'image', '${VALID_PNG_BASE64}', ${now})
    `);

    raw.exec(/*sql*/ `
      INSERT INTO message_attachments (id, message_id, attachment_id, position, created_at)
      VALUES ('ma-valid', 'msg-2', 'valid-1', 0, ${now})
    `);

    migrateScrubCorruptedImageAttachments(db);

    const attachmentCount = raw
      .query(`SELECT COUNT(*) AS count FROM attachments`)
      .get() as { count: number };
    expect(attachmentCount.count).toBe(1);

    const linkCount = raw
      .query(`SELECT COUNT(*) AS count FROM message_attachments`)
      .get() as { count: number };
    expect(linkCount.count).toBe(1);
  });

  test("removes corrupted and preserves valid attachments together", () => {
    const db = createTestDb();
    const raw = getRawSqlite(db);
    const now = Date.now();

    createRequiredTables(raw);

    // Corrupted attachment
    raw.exec(/*sql*/ `
      INSERT INTO attachments (id, original_filename, mime_type, size_bytes, kind, data_base64, created_at)
      VALUES ('corrupt-1', 'slack-img.png', 'image/png', 100, 'image', '${HTML_ERROR_BASE64}', ${now})
    `);
    raw.exec(/*sql*/ `
      INSERT INTO message_attachments (id, message_id, attachment_id, position, created_at)
      VALUES ('ma-corrupt', 'msg-1', 'corrupt-1', 0, ${now})
    `);

    // Valid attachment
    raw.exec(/*sql*/ `
      INSERT INTO attachments (id, original_filename, mime_type, size_bytes, kind, data_base64, created_at)
      VALUES ('valid-1', 'photo.png', 'image/png', 200, 'image', '${VALID_PNG_BASE64}', ${now})
    `);
    raw.exec(/*sql*/ `
      INSERT INTO message_attachments (id, message_id, attachment_id, position, created_at)
      VALUES ('ma-valid', 'msg-2', 'valid-1', 0, ${now})
    `);

    migrateScrubCorruptedImageAttachments(db);

    const remaining = raw.query(`SELECT id FROM attachments`).all() as Array<{
      id: string;
    }>;
    expect(remaining).toEqual([{ id: "valid-1" }]);

    const links = raw
      .query(`SELECT attachment_id FROM message_attachments`)
      .all() as Array<{ attachment_id: string }>;
    expect(links).toEqual([{ attachment_id: "valid-1" }]);
  });

  test("detects HTML with leading BOM and whitespace", () => {
    const db = createTestDb();
    const raw = getRawSqlite(db);
    const now = Date.now();

    createRequiredTables(raw);

    raw.exec(/*sql*/ `
      INSERT INTO attachments (id, original_filename, mime_type, size_bytes, kind, data_base64, created_at)
      VALUES ('bom-1', 'img.jpg', 'image/jpeg', 50, 'image', '${HTML_WITH_BOM_BASE64}', ${now})
    `);

    migrateScrubCorruptedImageAttachments(db);

    const count = raw
      .query(`SELECT COUNT(*) AS count FROM attachments`)
      .get() as { count: number };
    expect(count.count).toBe(0);
  });

  test("detects uppercase <HTML> tag", () => {
    const db = createTestDb();
    const raw = getRawSqlite(db);
    const now = Date.now();

    createRequiredTables(raw);

    raw.exec(/*sql*/ `
      INSERT INTO attachments (id, original_filename, mime_type, size_bytes, kind, data_base64, created_at)
      VALUES ('upper-1', 'img.gif', 'image/gif', 50, 'image', '${HTML_UPPERCASE_BASE64}', ${now})
    `);

    migrateScrubCorruptedImageAttachments(db);

    const count = raw
      .query(`SELECT COUNT(*) AS count FROM attachments`)
      .get() as { count: number };
    expect(count.count).toBe(0);
  });

  test("is idempotent — running twice does not error", () => {
    const db = createTestDb();
    const raw = getRawSqlite(db);
    const now = Date.now();

    createRequiredTables(raw);

    raw.exec(/*sql*/ `
      INSERT INTO attachments (id, original_filename, mime_type, size_bytes, kind, data_base64, created_at)
      VALUES ('corrupt-1', 'image.png', 'image/png', 100, 'image', '${HTML_ERROR_BASE64}', ${now})
    `);
    raw.exec(/*sql*/ `
      INSERT INTO message_attachments (id, message_id, attachment_id, position, created_at)
      VALUES ('ma-1', 'msg-1', 'corrupt-1', 0, ${now})
    `);

    migrateScrubCorruptedImageAttachments(db);
    migrateScrubCorruptedImageAttachments(db);

    const attachmentCount = raw
      .query(`SELECT COUNT(*) AS count FROM attachments`)
      .get() as { count: number };
    expect(attachmentCount.count).toBe(0);

    const linkCount = raw
      .query(`SELECT COUNT(*) AS count FROM message_attachments`)
      .get() as { count: number };
    expect(linkCount.count).toBe(0);

    // The checkpoint should be set to '1' (completed)
    const checkpoint = raw
      .query(
        `SELECT value FROM memory_checkpoints WHERE key = 'migration_scrub_corrupted_image_attachments_v1'`,
      )
      .get() as { value: string } | null;
    expect(checkpoint?.value).toBe("1");
  });

  test("skips non-image MIME types", () => {
    const db = createTestDb();
    const raw = getRawSqlite(db);
    const now = Date.now();

    createRequiredTables(raw);

    // HTML content with text/html MIME type — should NOT be touched
    raw.exec(/*sql*/ `
      INSERT INTO attachments (id, original_filename, mime_type, size_bytes, kind, data_base64, created_at)
      VALUES ('html-1', 'page.html', 'text/html', 100, 'document', '${HTML_ERROR_BASE64}', ${now})
    `);

    migrateScrubCorruptedImageAttachments(db);

    const count = raw
      .query(`SELECT COUNT(*) AS count FROM attachments`)
      .get() as { count: number };
    expect(count.count).toBe(1);
  });
});
