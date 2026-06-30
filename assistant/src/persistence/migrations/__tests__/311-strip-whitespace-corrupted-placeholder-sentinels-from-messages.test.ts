/**
 * Tests for migration 311 — sweeping placeholder-sentinel text blocks whose
 * `\x00` guard byte was replaced by surrounding whitespace (e.g. a leading
 * space) before persistence. The trimmed match is a superset of migration 222,
 * so the exact forms are dropped too, while non-sentinel content (including
 * mid-text mentions of the marker) is preserved.
 */
import { describe, expect, test } from "bun:test";

const { getDb, getSqlite } = await import("../../db-connection.js");
const { initializeDb } = await import("../../db-init.js");
const { PLACEHOLDER_EMPTY_TURN, PLACEHOLDER_BLOCKS_OMITTED } =
  await import("../../../providers/placeholder-sentinels.js");
const {
  migrateStripWhitespaceCorruptedPlaceholderSentinelsFromMessages,
  ROWID_WINDOW,
  WINDOW_TIMEOUT_MS,
} =
  await import("../311-strip-whitespace-corrupted-placeholder-sentinels-from-messages.js");
const { loadRawConfig, saveRawConfig } =
  await import("../../../config/loader.js");

await initializeDb();

// The sweep is gated behind `migrations.worker.enabled` (default false). Enable
// it so the migration does its work for these tests.
const rawConfig = loadRawConfig();
rawConfig.migrations = { worker: { enabled: true } };
saveRawConfig(rawConfig);

const CONV = "conv-311";
getSqlite()
  .query(
    `INSERT OR IGNORE INTO conversations (id, created_at, updated_at) VALUES (?, ?, ?)`,
  )
  .run(CONV, Date.now(), Date.now());

let seq = 0;
function insert(role: string, content: string): { id: string } {
  const id = `m311-${seq++}`;
  getSqlite()
    .query(
      `INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, CONV, role, content, Date.now());
  return { id };
}

function content(id: string): string {
  return (
    getSqlite().query(`SELECT content FROM messages WHERE id = ?`).get(id) as {
      content: string;
    }
  ).content;
}

function blocks(id: string): Array<Record<string, unknown>> {
  return JSON.parse(content(id));
}

// The leak observed in production: an Anthropic-compatible proxy replaces the
// `\x00` guard byte with a leading space before echoing the marker back.
const SPACE_EMPTY = ` ${PLACEHOLDER_EMPTY_TURN.slice(1)}`;
const SPACE_BLOCKS = ` ${PLACEHOLDER_BLOCKS_OMITTED.slice(1)}`;

describe("migration 311 — strip whitespace-corrupted placeholder sentinels", () => {
  test("collapses a leading-space-corrupted all-sentinel row to []", async () => {
    const { id } = insert(
      "assistant",
      JSON.stringify([{ type: "text", text: SPACE_EMPTY }]),
    );

    await migrateStripWhitespaceCorruptedPlaceholderSentinelsFromMessages(
      getDb(),
    );

    expect(blocks(id)).toEqual([]);
  });

  test("strips a leading-space-corrupted sentinel but keeps real content", async () => {
    const { id } = insert(
      "assistant",
      JSON.stringify([
        { type: "text", text: SPACE_BLOCKS },
        { type: "text", text: "kept" },
      ]),
    );

    await migrateStripWhitespaceCorruptedPlaceholderSentinelsFromMessages(
      getDb(),
    );

    expect(blocks(id)).toEqual([{ type: "text", text: "kept" }]);
  });

  test("also strips the exact (uncorrupted) sentinel forms — superset of 222", async () => {
    const { id } = insert(
      "assistant",
      JSON.stringify([
        { type: "text", text: PLACEHOLDER_EMPTY_TURN },
        { type: "text", text: PLACEHOLDER_BLOCKS_OMITTED.slice(1) },
      ]),
    );

    await migrateStripWhitespaceCorruptedPlaceholderSentinelsFromMessages(
      getDb(),
    );

    expect(blocks(id)).toEqual([]);
  });

  test("leaves a non-exact __PLACEHOLDER__ substring untouched", async () => {
    const original = JSON.stringify([
      {
        type: "text",
        text: "log line: __PLACEHOLDER__[empty assistant turn] seen",
      },
    ]);
    const { id } = insert("assistant", original);

    await migrateStripWhitespaceCorruptedPlaceholderSentinelsFromMessages(
      getDb(),
    );

    expect(content(id)).toBe(original);
  });

  test("does not touch non-assistant roles", async () => {
    const original = JSON.stringify([{ type: "text", text: SPACE_EMPTY }]);
    const { id } = insert("user", original);

    await migrateStripWhitespaceCorruptedPlaceholderSentinelsFromMessages(
      getDb(),
    );

    expect(content(id)).toBe(original);
  });

  test("is idempotent across repeated runs", async () => {
    const { id } = insert(
      "assistant",
      JSON.stringify([
        { type: "text", text: SPACE_EMPTY },
        { type: "text", text: "stable" },
      ]),
    );

    await migrateStripWhitespaceCorruptedPlaceholderSentinelsFromMessages(
      getDb(),
    );
    const once = content(id);
    await migrateStripWhitespaceCorruptedPlaceholderSentinelsFromMessages(
      getDb(),
    );

    expect(content(id)).toBe(once);
    expect(blocks(id)).toEqual([{ type: "text", text: "stable" }]);
  });

  test("keeps the sweep window and timeout bounded", () => {
    expect(ROWID_WINDOW).toBeLessThanOrEqual(10_000);
    expect(WINDOW_TIMEOUT_MS).toBeLessThan(60 * 60 * 1000);
  });
});
