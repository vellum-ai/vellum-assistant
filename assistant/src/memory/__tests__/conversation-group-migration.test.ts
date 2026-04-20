import { beforeAll, describe, expect, mock, test } from "bun:test";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { ensureGroupMigration } from "../conversation-group-migration.js";
import { initializeDb, rawAll, rawExec, rawGet, rawRun } from "../db.js";

initializeDb();

// Simulate a legacy install that has the `system:reflections` system group
// plus a conversation pointing at it. The migration must:
//   1. Seed the current system groups (without `system:reflections`).
//   2. Move the legacy conversation to `system:background` (step 6).
//   3. Delete the orphaned `system:reflections` row (step 7).
//
// We pre-create the `conversation_groups` table and `group_id` column directly
// because the migration's own CREATE TABLE IF NOT EXISTS / ALTER TABLE steps
// would otherwise be the first to introduce them — there's no way to seed the
// "legacy" row until they exist.
describe("ensureGroupMigration — reflections cleanup", () => {
  beforeAll(() => {
    rawExec(`
      CREATE TABLE IF NOT EXISTS conversation_groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        sort_position REAL NOT NULL DEFAULT 0,
        is_system_group BOOLEAN NOT NULL DEFAULT FALSE,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
      )
    `);
    try {
      rawRun(
        "ALTER TABLE conversations ADD COLUMN group_id TEXT REFERENCES conversation_groups(id) ON DELETE SET NULL",
      );
    } catch {
      // column already present — ok
    }
    rawRun(
      "INSERT OR IGNORE INTO conversation_groups (id, name, sort_position, is_system_group) VALUES ('system:reflections', 'Reflections', 100, TRUE)",
    );
    const now = Math.floor(Date.now() / 1000);
    rawRun(
      "INSERT INTO conversations (id, created_at, updated_at, group_id) VALUES (?, ?, ?, ?)",
      "legacy-refl-1",
      now,
      now,
      "system:reflections",
    );

    ensureGroupMigration();
  });

  test("moves legacy system:reflections conversations to system:background", () => {
    const legacy = rawGet<{ group_id: string | null }>(
      "SELECT group_id FROM conversations WHERE id = 'legacy-refl-1'",
    );
    expect(legacy?.group_id).toBe("system:background");
  });

  test("deletes the orphaned system:reflections group row", () => {
    const refl = rawGet<{ id: string }>(
      "SELECT id FROM conversation_groups WHERE id = 'system:reflections'",
    );
    expect(refl).toBeNull();
  });

  test("seeds the current system groups without system:reflections", () => {
    const systemIds = rawAll<{ id: string }>(
      "SELECT id FROM conversation_groups WHERE id LIKE 'system:%' ORDER BY id",
    ).map((r) => r.id);
    expect(systemIds).toEqual([
      "system:all",
      "system:background",
      "system:pinned",
      "system:scheduled",
    ]);
  });

  test("records the cleanup sentinel so the step is idempotent", () => {
    const sentinel = rawGet<{ id: string }>(
      "SELECT id FROM conversation_groups WHERE id = '_reflections_group_deleted_complete'",
    );
    expect(sentinel?.id).toBe("_reflections_group_deleted_complete");
  });

  test("re-running ensureGroupMigration does not recreate the stale group", () => {
    expect(() => ensureGroupMigration()).not.toThrow();
    const refl = rawGet<{ id: string }>(
      "SELECT id FROM conversation_groups WHERE id = 'system:reflections'",
    );
    expect(refl).toBeNull();
  });
});
