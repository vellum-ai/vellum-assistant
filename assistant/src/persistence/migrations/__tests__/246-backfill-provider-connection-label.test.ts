import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { getSqliteFrom } from "../../db-connection.js";
import * as schema from "../../schema.js";
import { migrateCreateProviderConnections } from "../243-provider-connections.js";
import { migrateProviderConnectionStatusLabel } from "../244-provider-connection-status-label.js";
import { migrateBackfillProviderConnectionLabel } from "../246-backfill-provider-connection-label.js";

interface ConnectionRow {
  name: string;
  label: string | null;
}

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");
  return drizzle(sqlite, { schema });
}

/// Ensure the `memory_checkpoints` table exists in test DBs — it's normally
/// provisioned by earlier infra migrations that the test harness doesn't
/// pull in. Schema mirrors what other backfill migrations expect.
function ensureCheckpointsTable(db: ReturnType<typeof createTestDb>): void {
  const raw = getSqliteFrom(db);
  raw.exec(`
    CREATE TABLE IF NOT EXISTS memory_checkpoints (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at INTEGER
    )
  `);
}

/// Bring the test DB up to the state right before migration 246 runs:
/// provider_connections table present + status/label columns added.
function prepareSchemaThroughMigration244(
  db: ReturnType<typeof createTestDb>,
): void {
  migrateCreateProviderConnections(db);
  migrateProviderConnectionStatusLabel(db);
  ensureCheckpointsTable(db);
}

describe("migration 246 — backfill provider_connection label", () => {
  test("sets label = name for rows where label is NULL", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    prepareSchemaThroughMigration244(db);

    // Insert a row with label = NULL (simulating a pre-244 connection).
    const now = Date.now();
    raw
      .query(
        `INSERT INTO provider_connections (name, provider, auth, status, label, created_at, updated_at) VALUES (?, ?, ?, 'active', NULL, ?, ?)`,
      )
      .run(
        "anthropic-personal",
        "anthropic",
        JSON.stringify({
          type: "api_key",
          credential: "credential/anthropic/api_key",
        }),
        now,
        now,
      );

    migrateBackfillProviderConnectionLabel(db);

    const row = raw
      .query(`SELECT name, label FROM provider_connections WHERE name = ?`)
      .get("anthropic-personal") as ConnectionRow;
    expect(row.label).toBe("anthropic-personal");
  });

  test("sets label = name for rows where label is empty/whitespace", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    prepareSchemaThroughMigration244(db);

    const now = Date.now();
    raw
      .query(
        `INSERT INTO provider_connections (name, provider, auth, status, label, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?, ?)`,
      )
      .run(
        "openai-empty",
        "openai",
        JSON.stringify({
          type: "api_key",
          credential: "credential/openai/api_key",
        }),
        "",
        now,
        now,
      );
    raw
      .query(
        `INSERT INTO provider_connections (name, provider, auth, status, label, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?, ?)`,
      )
      .run(
        "openai-whitespace",
        "openai",
        JSON.stringify({
          type: "api_key",
          credential: "credential/openai/api_key",
        }),
        "   ",
        now,
        now,
      );

    migrateBackfillProviderConnectionLabel(db);

    const empty = raw
      .query(`SELECT label FROM provider_connections WHERE name = ?`)
      .get("openai-empty") as ConnectionRow;
    const whitespace = raw
      .query(`SELECT label FROM provider_connections WHERE name = ?`)
      .get("openai-whitespace") as ConnectionRow;
    expect(empty.label).toBe("openai-empty");
    expect(whitespace.label).toBe("openai-whitespace");
  });

  test("does NOT overwrite rows where the user has set a non-empty label", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    prepareSchemaThroughMigration244(db);

    const now = Date.now();
    raw
      .query(
        `INSERT INTO provider_connections (name, provider, auth, status, label, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?, ?)`,
      )
      .run(
        "anthropic-work",
        "anthropic",
        JSON.stringify({
          type: "api_key",
          credential: "credential/anthropic/api_key",
        }),
        "Anthropic — Work",
        now,
        now,
      );

    migrateBackfillProviderConnectionLabel(db);

    const row = raw
      .query(`SELECT label FROM provider_connections WHERE name = ?`)
      .get("anthropic-work") as ConnectionRow;
    expect(row.label).toBe("Anthropic — Work");
  });

  test("is idempotent — second run does not re-clobber a later user-cleared label", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    prepareSchemaThroughMigration244(db);

    const now = Date.now();
    raw
      .query(
        `INSERT INTO provider_connections (name, provider, auth, status, label, created_at, updated_at) VALUES (?, ?, ?, 'active', NULL, ?, ?)`,
      )
      .run(
        "anthropic-personal",
        "anthropic",
        JSON.stringify({
          type: "api_key",
          credential: "credential/anthropic/api_key",
        }),
        now,
        now,
      );

    // First run: backfills NULL → "anthropic-personal".
    migrateBackfillProviderConnectionLabel(db);
    expect(
      (
        raw
          .query(`SELECT label FROM provider_connections WHERE name = ?`)
          .get("anthropic-personal") as ConnectionRow
      ).label,
    ).toBe("anthropic-personal");

    // User clears the label after the backfill ran.
    raw
      .query(`UPDATE provider_connections SET label = NULL WHERE name = ?`)
      .run("anthropic-personal");

    // Second run: should NOT re-clobber the user's deliberate clear, because
    // the checkpoint was set on the first successful run.
    migrateBackfillProviderConnectionLabel(db);
    expect(
      (
        raw
          .query(`SELECT label FROM provider_connections WHERE name = ?`)
          .get("anthropic-personal") as ConnectionRow
      ).label,
    ).toBeNull();
  });

  test("checkpoint is set after a successful run", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    prepareSchemaThroughMigration244(db);

    migrateBackfillProviderConnectionLabel(db);

    const checkpoint = raw
      .query(`SELECT key FROM memory_checkpoints WHERE key = ?`)
      .get("backfill_provider_connection_label") as { key: string } | null;
    expect(checkpoint).not.toBeNull();
    expect(checkpoint?.key).toBe("backfill_provider_connection_label");
  });

  test("no-op when provider_connections table is absent (first-boot edge)", () => {
    const db = createTestDb();
    ensureCheckpointsTable(db);

    // Don't run 243/244 — the table doesn't exist yet.
    expect(() => migrateBackfillProviderConnectionLabel(db)).not.toThrow();

    // Checkpoint should still get set so we don't retry forever.
    const raw = getSqliteFrom(db);
    const checkpoint = raw
      .query(`SELECT key FROM memory_checkpoints WHERE key = ?`)
      .get("backfill_provider_connection_label");
    expect(checkpoint).not.toBeNull();
  });

  test("no-op when label column is absent (244 hasn't run yet) — no checkpoint set", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    migrateCreateProviderConnections(db); // 243 only, NOT 244
    ensureCheckpointsTable(db);

    expect(() => migrateBackfillProviderConnectionLabel(db)).not.toThrow();

    // Crucially: no checkpoint should be set, so the backfill can run later
    // once 244 has provisioned the column.
    const checkpoint = raw
      .query(`SELECT key FROM memory_checkpoints WHERE key = ?`)
      .get("backfill_provider_connection_label");
    expect(checkpoint).toBeNull();
  });
});
