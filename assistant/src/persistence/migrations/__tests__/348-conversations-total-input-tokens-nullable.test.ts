/**
 * Tests for migration 348 — dropping NOT NULL from
 * conversations.total_input_tokens via table rebuild.
 *
 * `initializeDb()` runs the full chain: 000 creates the column NOT NULL and
 * 348 rebuilds the table without the constraint, so these tests exercise the
 * real rebuild path, then verify idempotency and index preservation.
 */
import { describe, expect, test } from "bun:test";

const { getDb, getSqlite } = await import("../../db-connection.js");
const { initializeDb } = await import("../../db-init.js");
const { migrateConversationsTotalInputTokensNullable } =
  await import("../348-conversations-total-input-tokens-nullable.js");

await initializeDb();

function columnInfo(name: string): { notnull: number; dflt_value: unknown } {
  const rows = getSqlite()
    .query(`PRAGMA table_info(conversations)`)
    .all() as Array<{ name: string; notnull: number; dflt_value: unknown }>;
  const col = rows.find((r) => r.name === name);
  if (!col) throw new Error(`column ${name} missing`);
  return col;
}

function indexNames(): string[] {
  return (
    getSqlite()
      .query(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'conversations' AND sql IS NOT NULL ORDER BY name`,
      )
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
}

describe("migration 348 — nullable total_input_tokens", () => {
  test("drops NOT NULL, keeps DEFAULT 0 and sibling constraints", () => {
    expect(columnInfo("total_input_tokens").notnull).toBe(0);
    expect(columnInfo("total_input_tokens").dflt_value).toBe("0");
    expect(columnInfo("total_output_tokens").notnull).toBe(1);
    expect(columnInfo("created_at").notnull).toBe(1);
  });

  test("accepts an explicit NULL total_input_tokens", () => {
    getSqlite()
      .query(
        `INSERT INTO conversations (id, created_at, updated_at, total_input_tokens) VALUES (?, ?, ?, NULL)`,
      )
      .run("conv-348-null", Date.now(), Date.now());
    const row = getSqlite()
      .query(
        `SELECT total_input_tokens FROM conversations WHERE id = 'conv-348-null'`,
      )
      .get() as { total_input_tokens: number | null };
    expect(row.total_input_tokens).toBeNull();
  });

  test("preserves the conversations indexes across the rebuild", () => {
    expect(indexNames()).toContain("idx_conversations_updated_at");
    expect(indexNames()).toContain("idx_conversations_last_message_at");
    expect(indexNames()).toContain("idx_conversations_parent_conversation_id");
  });

  test("is idempotent — re-running no-ops and preserves rows", () => {
    const before = indexNames();
    migrateConversationsTotalInputTokensNullable(getDb());
    expect(indexNames()).toEqual(before);
    expect(
      getSqlite()
        .query(`SELECT 1 FROM conversations WHERE id = 'conv-348-null'`)
        .get(),
    ).not.toBeNull();
  });
});
