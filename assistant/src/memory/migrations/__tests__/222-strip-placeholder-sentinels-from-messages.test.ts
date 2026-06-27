/**
 * Tests for migration 222 — stripping placeholder-sentinel text blocks from
 * persisted assistant messages.
 *
 * The migration rewrites content entirely inside SQLite (JSON1), dispatched a
 * rowid window at a time through `runAsyncSqlite`. These tests drive the step
 * directly against a real DB and assert the at-rest content, idempotency,
 * scoping (assistant rows only), tolerance of malformed content, that both the
 * null-byte-prefixed and bare sentinel forms are dropped, and that a span wider
 * than one window is swept across multiple windows.
 */
import { describe, expect, test } from "bun:test";

const { getDb, getSqlite } = await import("../../db-connection.js");
const { initializeDb } = await import("../../db-init.js");
const { PLACEHOLDER_EMPTY_TURN, PLACEHOLDER_BLOCKS_OMITTED } =
  await import("../../../providers/placeholder-sentinels.js");
const {
  migrateStripPlaceholderSentinelsFromMessages,
  ROWID_WINDOW,
  WINDOW_TIMEOUT_MS,
} = await import("../222-strip-placeholder-sentinels-from-messages.js");
const { loadRawConfig, saveRawConfig } =
  await import("../../../config/loader.js");

await initializeDb();

// The sweep is gated behind `migrations.worker.enabled` (default false), under
// which it short-circuits and passes. Enable it so the migration does its work
// for these tests.
const rawConfig = loadRawConfig();
rawConfig.migrations = { worker: { enabled: true } };
saveRawConfig(rawConfig);

const CONV = "conv-222";
getSqlite()
  .query(
    `INSERT OR IGNORE INTO conversations (id, created_at, updated_at) VALUES (?, ?, ?)`,
  )
  .run(CONV, Date.now(), Date.now());

let seq = 0;
function insert(role: string, content: string): { id: string; rowid: number } {
  const id = `m222-${seq++}`;
  getSqlite()
    .query(
      `INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, CONV, role, content, Date.now());
  const rowid = (
    getSqlite()
      .query(`SELECT rowid AS r FROM messages WHERE id = ?`)
      .get(id) as { r: number }
  ).r;
  return { id, rowid };
}

/** Insert at an explicit rowid so a test can place rows on either side of a
 *  window boundary without materializing every intervening row. */
function insertAt(
  rowid: number,
  role: string,
  content: string,
): { id: string; rowid: number } {
  const id = `m222-at-${rowid}`;
  getSqlite()
    .query(
      `INSERT INTO messages (rowid, id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(rowid, id, CONV, role, content, Date.now());
  return { id, rowid };
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

describe("migration 222 — strip placeholder sentinels from assistant messages", () => {
  test("strips the sentinel text block but keeps text and tool_use, preserving order", async () => {
    const { id } = insert(
      "assistant",
      JSON.stringify([
        { type: "text", text: "hello" },
        { type: "text", text: PLACEHOLDER_EMPTY_TURN },
        { type: "tool_use", id: "t1", name: "x", input: { a: 1 } },
      ]),
    );

    await migrateStripPlaceholderSentinelsFromMessages(getDb());

    expect(blocks(id)).toEqual([
      { type: "text", text: "hello" },
      { type: "tool_use", id: "t1", name: "x", input: { a: 1 } },
    ]);
  });

  test("strips the bare (null-byte-less) sentinel form too", async () => {
    const { id } = insert(
      "assistant",
      JSON.stringify([
        { type: "text", text: PLACEHOLDER_BLOCKS_OMITTED.slice(1) },
        { type: "text", text: "kept" },
      ]),
    );

    await migrateStripPlaceholderSentinelsFromMessages(getDb());

    expect(blocks(id)).toEqual([{ type: "text", text: "kept" }]);
  });

  test("all-sentinel message becomes an empty array", async () => {
    const { id } = insert(
      "assistant",
      JSON.stringify([
        { type: "text", text: PLACEHOLDER_EMPTY_TURN },
        { type: "text", text: PLACEHOLDER_BLOCKS_OMITTED },
      ]),
    );

    await migrateStripPlaceholderSentinelsFromMessages(getDb());

    expect(blocks(id)).toEqual([]);
  });

  test("preserves blocks with a missing/null type", async () => {
    const { id } = insert(
      "assistant",
      JSON.stringify([
        { type: "text", text: PLACEHOLDER_EMPTY_TURN },
        { foo: "bar" },
        { type: "text", text: "kept" },
      ]),
    );

    await migrateStripPlaceholderSentinelsFromMessages(getDb());

    expect(blocks(id)).toEqual([
      { foo: "bar" },
      { type: "text", text: "kept" },
    ]);
  });

  test("leaves a non-exact __PLACEHOLDER__ substring untouched", async () => {
    // The marker appears inside a longer string but the block is not an exact
    // sentinel, so it must be preserved verbatim.
    const original = JSON.stringify([
      {
        type: "text",
        text: "log line: __PLACEHOLDER__[empty assistant turn] seen",
      },
    ]);
    const { id } = insert("assistant", original);

    await migrateStripPlaceholderSentinelsFromMessages(getDb());

    expect(content(id)).toBe(original);
  });

  test("does not touch non-assistant roles", async () => {
    const original = JSON.stringify([
      { type: "text", text: PLACEHOLDER_EMPTY_TURN },
      { type: "text", text: "u" },
    ]);
    const { id } = insert("user", original);

    await migrateStripPlaceholderSentinelsFromMessages(getDb());

    expect(content(id)).toBe(original);
  });

  test("tolerates non-array and invalid JSON content", async () => {
    const obj = insert(
      "assistant",
      JSON.stringify({ type: "text", text: PLACEHOLDER_EMPTY_TURN }),
    );
    const invalid = insert(
      "assistant",
      "{not json with __PLACEHOLDER__[empty assistant turn]",
    );

    await migrateStripPlaceholderSentinelsFromMessages(getDb());

    expect(content(obj.id)).toBe(
      JSON.stringify({ type: "text", text: PLACEHOLDER_EMPTY_TURN }),
    );
    expect(content(invalid.id)).toBe(
      "{not json with __PLACEHOLDER__[empty assistant turn]",
    );
  });

  test("is idempotent across repeated runs", async () => {
    const { id } = insert(
      "assistant",
      JSON.stringify([
        { type: "text", text: PLACEHOLDER_EMPTY_TURN },
        { type: "text", text: "stable" },
      ]),
    );

    await migrateStripPlaceholderSentinelsFromMessages(getDb());
    const once = content(id);
    await migrateStripPlaceholderSentinelsFromMessages(getDb());
    const twice = content(id);

    expect(twice).toBe(once);
    expect(blocks(id)).toEqual([{ type: "text", text: "stable" }]);
  });

  test("sweeps a rowid span wider than one window across multiple windows", async () => {
    const base =
      (
        getSqlite().query(`SELECT MAX(rowid) AS m FROM messages`).get() as {
          m: number | null;
        }
      ).m ?? 0;
    const first = insertAt(
      base + ROWID_WINDOW,
      "assistant",
      JSON.stringify([
        { type: "text", text: PLACEHOLDER_EMPTY_TURN },
        { type: "text", text: "first" },
      ]),
    );
    const second = insertAt(
      base + 2 * ROWID_WINDOW + 1,
      "assistant",
      JSON.stringify([
        { type: "text", text: PLACEHOLDER_EMPTY_TURN },
        { type: "text", text: "second" },
      ]),
    );

    await migrateStripPlaceholderSentinelsFromMessages(getDb());

    expect(blocks(first.id)).toEqual([{ type: "text", text: "first" }]);
    expect(blocks(second.id)).toEqual([{ type: "text", text: "second" }]);
  });

  test("skips the sweep and passes when migrations.worker.enabled is false", async () => {
    const original = JSON.stringify([
      { type: "text", text: PLACEHOLDER_EMPTY_TURN },
      { type: "text", text: "gated" },
    ]);
    const { id } = insert("assistant", original);

    const disabled = loadRawConfig();
    disabled.migrations = { worker: { enabled: false } };
    saveRawConfig(disabled);
    try {
      // Resolves without throwing and leaves the row untouched — the work is
      // deferred to the async migration runner.
      await migrateStripPlaceholderSentinelsFromMessages(getDb());
      expect(content(id)).toBe(original);
    } finally {
      const enabled = loadRawConfig();
      enabled.migrations = { worker: { enabled: true } };
      saveRawConfig(enabled);
    }
  });

  test("keeps the sweep window and timeout bounded so it cannot overrun a whole table", () => {
    expect(ROWID_WINDOW).toBeLessThanOrEqual(10_000);
    expect(WINDOW_TIMEOUT_MS).toBeLessThan(60 * 60 * 1000);
  });
});
