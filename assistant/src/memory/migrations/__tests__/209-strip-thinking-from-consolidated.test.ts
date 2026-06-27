/**
 * Tests for migration 209 — stripping thinking / redacted_thinking blocks from
 * persisted assistant messages.
 *
 * The migration rewrites content entirely inside SQLite (JSON1), dispatched a
 * rowid window at a time through `runAsyncSqlite`. These tests drive the step
 * directly against a real DB and assert the at-rest content, idempotency,
 * scoping (assistant rows only), tolerance of malformed content, and that the
 * persisted rowid watermark is honored for resume.
 */
import { describe, expect, test } from "bun:test";

const { getDb, getSqlite } = await import("../../db-connection.js");
const { initializeDb } = await import("../../db-init.js");
const {
  migrateStripThinkingFromConsolidated,
  ROWID_WINDOW,
  WINDOW_TIMEOUT_MS,
} = await import("../209-strip-thinking-from-consolidated.js");
const { loadRawConfig, saveRawConfig } =
  await import("../../../config/loader.js");

await initializeDb();

// The sweep is gated behind `migrations.worker.enabled` (default false), under
// which it short-circuits and passes. Enable it so the migration does its work
// for these tests.
const rawConfig = loadRawConfig();
rawConfig.migrations = { worker: { enabled: true } };
saveRawConfig(rawConfig);

const CONV = "conv-209";
getSqlite()
  .query(
    `INSERT OR IGNORE INTO conversations (id, created_at, updated_at) VALUES (?, ?, ?)`,
  )
  .run(CONV, Date.now(), Date.now());

let seq = 0;
function insert(role: string, content: string): { id: string; rowid: number } {
  const id = `m209-${seq++}`;
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
  const id = `m209-at-${rowid}`;
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

/** The persisted resume watermark, or null once the sweep has cleared it. */
function watermark(): unknown {
  return getSqlite()
    .query(`SELECT value FROM memory_checkpoints WHERE key = ?`)
    .get("migration_209_strip_thinking_watermark");
}

describe("migration 209 — strip thinking from consolidated assistant messages", () => {
  test("strips thinking blocks but keeps text and tool_use, preserving order", async () => {
    const { id } = insert(
      "assistant",
      JSON.stringify([
        { type: "thinking", thinking: "secret", signature: "sig" },
        { type: "text", text: "hello" },
        { type: "tool_use", id: "t1", name: "x", input: { a: 1 } },
      ]),
    );

    await migrateStripThinkingFromConsolidated(getDb());

    expect(blocks(id)).toEqual([
      { type: "text", text: "hello" },
      { type: "tool_use", id: "t1", name: "x", input: { a: 1 } },
    ]);
  });

  test("strips redacted_thinking blocks", async () => {
    const { id } = insert(
      "assistant",
      JSON.stringify([
        { type: "redacted_thinking", data: "blob" },
        { type: "text", text: "world" },
      ]),
    );

    await migrateStripThinkingFromConsolidated(getDb());

    expect(blocks(id)).toEqual([{ type: "text", text: "world" }]);
  });

  test("all-thinking message becomes the null-byte placeholder sentinel", async () => {
    const { id } = insert(
      "assistant",
      JSON.stringify([
        { type: "thinking", thinking: "a", signature: "s1" },
        { type: "redacted_thinking", data: "b" },
      ]),
    );

    await migrateStripThinkingFromConsolidated(getDb());

    const result = blocks(id);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("text");
    expect(result[0].text).toBe("\x00__PLACEHOLDER__[internal blocks omitted]");
    // The leading byte must be a literal NUL, produced by SQLite's char(0).
    expect((result[0].text as string).charCodeAt(0)).toBe(0);
  });

  test("preserves blocks with a missing/null type", async () => {
    const { id } = insert(
      "assistant",
      JSON.stringify([
        { type: "thinking", thinking: "x", signature: "s" },
        { foo: "bar" },
        { type: "text", text: "kept" },
      ]),
    );

    await migrateStripThinkingFromConsolidated(getDb());

    expect(blocks(id)).toEqual([
      { foo: "bar" },
      { type: "text", text: "kept" },
    ]);
  });

  test("leaves thinking-free assistant messages untouched", async () => {
    const original = JSON.stringify([
      { type: "text", text: "I was thinking about lunch" },
    ]);
    const { id } = insert("assistant", original);

    await migrateStripThinkingFromConsolidated(getDb());

    // Substring 'thinking' appears in the text but no block is of thinking type.
    expect(content(id)).toBe(original);
  });

  test("does not touch non-assistant roles", async () => {
    const original = JSON.stringify([
      { type: "thinking", thinking: "x", signature: "s" },
      { type: "text", text: "u" },
    ]);
    const { id } = insert("user", original);

    await migrateStripThinkingFromConsolidated(getDb());

    expect(content(id)).toBe(original);
  });

  test("tolerates non-array and invalid JSON content", async () => {
    const obj = insert(
      "assistant",
      JSON.stringify({ type: "thinking", thinking: "x" }),
    );
    const invalid = insert("assistant", "{not json with thinking");

    await migrateStripThinkingFromConsolidated(getDb());

    expect(content(obj.id)).toBe(
      JSON.stringify({ type: "thinking", thinking: "x" }),
    );
    expect(content(invalid.id)).toBe("{not json with thinking");
  });

  test("is idempotent across repeated runs", async () => {
    const { id } = insert(
      "assistant",
      JSON.stringify([
        { type: "thinking", thinking: "x", signature: "s" },
        { type: "text", text: "stable" },
      ]),
    );

    await migrateStripThinkingFromConsolidated(getDb());
    const once = content(id);
    await migrateStripThinkingFromConsolidated(getDb());
    const twice = content(id);

    expect(twice).toBe(once);
    expect(blocks(id)).toEqual([{ type: "text", text: "stable" }]);
  });

  test("honors the persisted rowid watermark and resumes above it", async () => {
    const below = insert(
      "assistant",
      JSON.stringify([
        { type: "thinking", thinking: "x", signature: "s" },
        { type: "text", text: "below" },
      ]),
    );
    const above = insert(
      "assistant",
      JSON.stringify([
        { type: "thinking", thinking: "y", signature: "s" },
        { type: "text", text: "above" },
      ]),
    );

    // Pretend a prior run already swept through `below`'s rowid: the sweep must
    // resume strictly above it, leaving `below` untouched and cleaning `above`.
    getSqlite()
      .query(
        `INSERT OR REPLACE INTO memory_checkpoints (key, value, updated_at) VALUES (?, ?, ?)`,
      )
      .run(
        "migration_209_strip_thinking_watermark",
        String(below.rowid),
        Date.now(),
      );

    await migrateStripThinkingFromConsolidated(getDb());

    expect(blocks(below.id)).toEqual([
      { type: "thinking", thinking: "x", signature: "s" },
      { type: "text", text: "below" },
    ]);
    expect(blocks(above.id)).toEqual([{ type: "text", text: "above" }]);

    // The watermark is cleared once the sweep reaches the end of the table.
    expect(watermark()).toBeNull();
  });

  test("sweeps a rowid span wider than one window across multiple windows", async () => {
    // Place rows on either side of a window boundary so the sweep must iterate
    // the window loop more than once to reach them. The original 100k window
    // collapsed any table smaller than itself into a single subprocess sweep —
    // this exercises the bounded-window loop that replaces it.
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
        { type: "thinking", thinking: "a", signature: "s" },
        { type: "text", text: "first" },
      ]),
    );
    const second = insertAt(
      base + 2 * ROWID_WINDOW + 1,
      "assistant",
      JSON.stringify([
        { type: "thinking", thinking: "b", signature: "s" },
        { type: "text", text: "second" },
      ]),
    );

    await migrateStripThinkingFromConsolidated(getDb());

    // Both rows are cleaned even though they sit in different windows, and the
    // sweep runs to completion (watermark cleared) rather than stalling on the
    // first window.
    expect(blocks(first.id)).toEqual([{ type: "text", text: "first" }]);
    expect(blocks(second.id)).toEqual([{ type: "text", text: "second" }]);
    expect(watermark()).toBeNull();
  });

  test("skips the sweep and passes when migrations.worker.enabled is false", async () => {
    const original = JSON.stringify([
      { type: "thinking", thinking: "secret", signature: "s" },
      { type: "text", text: "gated" },
    ]);
    const { id } = insert("assistant", original);

    const disabled = loadRawConfig();
    disabled.migrations = { worker: { enabled: false } };
    saveRawConfig(disabled);
    try {
      // Resolves without throwing and leaves the row untouched — the work is
      // deferred to the async migration runner.
      await migrateStripThinkingFromConsolidated(getDb());
      expect(content(id)).toBe(original);
    } finally {
      const enabled = loadRawConfig();
      enabled.migrations = { worker: { enabled: true } };
      saveRawConfig(enabled);
    }
  });

  test("keeps the sweep window and timeout bounded so it cannot overrun a whole table", () => {
    // Regression guard: ROWID_WINDOW was 100_000, larger than a typical
    // messages table, so the entire table swept in one subprocess that overran
    // runAsyncSqlite's 1h cap, never advanced the watermark, and re-ran the
    // identical doomed window every boot. The window must stay small enough that
    // a single window finishes well within its timeout, and the per-window cap
    // must stay below the 1h whole-process default so a stuck window surfaces in
    // minutes instead of blocking startup for an hour.
    expect(ROWID_WINDOW).toBeLessThanOrEqual(10_000);
    expect(WINDOW_TIMEOUT_MS).toBeLessThan(60 * 60 * 1000);
  });
});
