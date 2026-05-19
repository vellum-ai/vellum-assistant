import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { tableHasColumn } from "./schema-introspection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

const CHECKPOINT_KEY = "migration_pkb_quality_fields_v1";

/**
 * Memory Maturation MVP — Phase 10B.
 *
 * Extends the Phase 5 PKB tables with the columns needed for confidence /
 * provenance / decay management and idempotent episode writes.
 *
 * `pkb_entities`:
 *   - `evidence_count` — number of times the entity has been reinforced.
 *   - `last_reinforced_at` — distinct from `last_seen_at`; bumped only on
 *     a true reinforcement event.
 *   - `provenance_json` — append-only list of source descriptors
 *     ({ sourceKind, sourceEventId, observedAt, contribution }), capped
 *     by the writer.
 *
 * `pkb_preferences`:
 *   - `evidence_count`, `positive_count`, `negative_count` — counter-based
 *     confidence (beta-mean of positive/(positive+negative)).
 *   - `last_reinforced_at`, `last_contradicted_at` — recency anchors for
 *     decay + feedback observability.
 *
 * `pkb_episodes`:
 *   - `idempotency_key` — optional; partial unique index lets callers
 *     pass `${sourceEventId}:${interpretedKind}` and get an idempotent
 *     insert without affecting the existing unkeyed writes.
 */
export function migratePkbQualityFields(database: DrizzleDb): void {
  withCrashRecovery(database, CHECKPOINT_KEY, () => {
    const raw = getSqliteFrom(database);

    if (!tableHasColumn(database, "pkb_entities", "evidence_count")) {
      raw.exec(
        `ALTER TABLE pkb_entities ADD COLUMN evidence_count INTEGER NOT NULL DEFAULT 1`,
      );
    }
    if (!tableHasColumn(database, "pkb_entities", "last_reinforced_at")) {
      raw.exec(
        `ALTER TABLE pkb_entities ADD COLUMN last_reinforced_at INTEGER`,
      );
    }
    if (!tableHasColumn(database, "pkb_entities", "provenance_json")) {
      raw.exec(
        `ALTER TABLE pkb_entities ADD COLUMN provenance_json TEXT NOT NULL DEFAULT '[]'`,
      );
    }

    if (!tableHasColumn(database, "pkb_preferences", "evidence_count")) {
      raw.exec(
        `ALTER TABLE pkb_preferences ADD COLUMN evidence_count INTEGER NOT NULL DEFAULT 1`,
      );
    }
    if (!tableHasColumn(database, "pkb_preferences", "positive_count")) {
      raw.exec(
        `ALTER TABLE pkb_preferences ADD COLUMN positive_count INTEGER NOT NULL DEFAULT 1`,
      );
    }
    if (!tableHasColumn(database, "pkb_preferences", "negative_count")) {
      raw.exec(
        `ALTER TABLE pkb_preferences ADD COLUMN negative_count INTEGER NOT NULL DEFAULT 0`,
      );
    }
    if (!tableHasColumn(database, "pkb_preferences", "last_reinforced_at")) {
      raw.exec(
        `ALTER TABLE pkb_preferences ADD COLUMN last_reinforced_at INTEGER`,
      );
    }
    if (!tableHasColumn(database, "pkb_preferences", "last_contradicted_at")) {
      raw.exec(
        `ALTER TABLE pkb_preferences ADD COLUMN last_contradicted_at INTEGER`,
      );
    }

    if (!tableHasColumn(database, "pkb_episodes", "idempotency_key")) {
      raw.exec(`ALTER TABLE pkb_episodes ADD COLUMN idempotency_key TEXT`);
    }
    raw.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_pkb_episodes_scope_idempotency
        ON pkb_episodes(scope_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL
    `);
  });
}

export function downPkbQualityFields(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  raw.exec(`DROP INDEX IF EXISTS idx_pkb_episodes_scope_idempotency`);
  // SQLite supports DROP COLUMN since 3.35; the codebase already relies on
  // it via the other ALTER TABLE down migrations.
  if (tableHasColumn(database, "pkb_episodes", "idempotency_key")) {
    raw.exec(`ALTER TABLE pkb_episodes DROP COLUMN idempotency_key`);
  }
  for (const col of [
    "last_contradicted_at",
    "last_reinforced_at",
    "negative_count",
    "positive_count",
    "evidence_count",
  ]) {
    if (tableHasColumn(database, "pkb_preferences", col)) {
      raw.exec(`ALTER TABLE pkb_preferences DROP COLUMN ${col}`);
    }
  }
  for (const col of [
    "provenance_json",
    "last_reinforced_at",
    "evidence_count",
  ]) {
    if (tableHasColumn(database, "pkb_entities", col)) {
      raw.exec(`ALTER TABLE pkb_entities DROP COLUMN ${col}`);
    }
  }
}
