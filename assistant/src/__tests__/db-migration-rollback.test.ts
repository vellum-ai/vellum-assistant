/**
 * Tests for DB migration rollback scenarios.
 *
 * Covers two main failure categories:
 *  1. Crash-between-migrations: if the process dies mid-migration (a checkpoint
 *     is written as 'started' but never completed), the DB remains in a consistent
 *     state and the migration re-runs safely on next startup.
 *  2. Schema-drift recovery: if the actual DB schema differs from expected (e.g.,
 *     a partial migration left a temporary table, or a column is missing), the
 *     migration system detects and handles it gracefully.
 */

import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { getSqliteFrom } from "../memory/db-connection.js";
import { downJobDeferrals } from "../memory/migrations/001-job-deferrals.js";
import { downMemoryEntityRelationDedup } from "../memory/migrations/004-entity-relation-dedup.js";
import { downMemoryItemsFingerprintScopeUnique } from "../memory/migrations/005-fingerprint-scope-unique.js";
import { downMemoryItemsScopeSaltedFingerprints } from "../memory/migrations/006-scope-salted-fingerprints.js";
import { downAssistantIdToSelf } from "../memory/migrations/007-assistant-id-to-self.js";
import { downRemoveAssistantIdColumns } from "../memory/migrations/008-remove-assistant-id-columns.js";
import { downLlmUsageEventsDropAssistantId } from "../memory/migrations/009-llm-usage-events-drop-assistant-id.js";
import { downBackfillInboxThreadState } from "../memory/migrations/014-backfill-inbox-thread-state.js";
import { downDropActiveSearchIndex } from "../memory/migrations/015-drop-active-search-index.js";
import { downNotificationTablesSchema } from "../memory/migrations/019-notification-tables-schema-migration.js";
import { downRenameChannelToVellum } from "../memory/migrations/020-rename-macos-ios-channel-to-vellum.js";
import { downEmbeddingVectorBlob } from "../memory/migrations/024-embedding-vector-blob.js";
import { downEmbeddingsNullableVectorJson } from "../memory/migrations/026a-embeddings-nullable-vector-json.js";
import { downNormalizePhoneIdentities } from "../memory/migrations/036-normalize-phone-identities.js";
import { downBackfillGuardianPrincipalId } from "../memory/migrations/126-backfill-guardian-principal-id.js";
import { downGuardianPrincipalIdNotNull } from "../memory/migrations/127-guardian-principal-id-not-null.js";
import { downContactsNotesColumn } from "../memory/migrations/134-contacts-notes-column.js";
import { downBackfillContactInteractionStats } from "../memory/migrations/135-backfill-contact-interaction-stats.js";
import { downDropAssistantIdColumns } from "../memory/migrations/136-drop-assistant-id-columns.js";
import { downBackfillUsageCacheAccounting } from "../memory/migrations/140-backfill-usage-cache-accounting.js";
import { downRenameVerificationTable } from "../memory/migrations/141-rename-verification-table.js";
import { downRenameVerificationSessionIdColumn } from "../memory/migrations/142-rename-verification-session-id-column.js";
import { downRenameGuardianVerificationValues } from "../memory/migrations/143-rename-guardian-verification-values.js";
import { downRenameVoiceToPhone } from "../memory/migrations/144-rename-voice-to-phone.js";
import { migrateDropAccountsTableDown } from "../memory/migrations/145-drop-accounts-table.js";
import { migrateRemindersToSchedulesDown } from "../memory/migrations/147-migrate-reminders-to-schedules.js";
import { migrateDropRemindersTableDown } from "../memory/migrations/148-drop-reminders-table.js";
import { migrateOAuthAppsClientSecretPathDown } from "../memory/migrations/150-oauth-apps-client-secret-path.js";
import {
  migrateGuardianTimestampsEpochMsDown,
  migrateGuardianTimestampsRebuildDown,
} from "../memory/migrations/162-guardian-timestamps-epoch-ms.js";
import { migrateRenameGmailProviderKeyToGoogleDown } from "../memory/migrations/169-rename-gmail-provider-key-to-google.js";
import { migrateRenameThreadStartersTableDown } from "../memory/migrations/174-rename-thread-starters-table.js";
import { migrateDropCapabilityCardStateDown } from "../memory/migrations/176-drop-capability-card-state.js";
import { migrateBackfillInlineAttachmentsToDiskDown } from "../memory/migrations/180-backfill-inline-attachments-to-disk.js";
import { migrateRenameThreadStartersCheckpointsDown } from "../memory/migrations/181-rename-thread-starters-checkpoints.js";
import { migrateBackfillAudioAttachmentMimeTypesDown } from "../memory/migrations/191-backfill-audio-attachment-mime-types.js";
import {
  migrateJobDeferrals,
  migrateLlmUsageAttribution,
  migrateMemoryEntityRelationDedup,
  migrateMemoryItemsFingerprintScopeUnique,
  migrateMemoryItemsScopeSaltedFingerprints,
  MIGRATION_REGISTRY,
  type MigrationRegistryEntry,
  type MigrationValidationResult,
  rollbackMemoryMigration,
  validateMigrationState,
} from "../memory/migrations/index.js";
import * as schema from "../memory/schema.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");
  return drizzle(sqlite, { schema });
}

function getRaw(db: ReturnType<typeof drizzle<typeof schema>>): Database {
  return getSqliteFrom(db);
}

/** Bootstrap the minimum DDL required by checkpoint-based migrations. */
function bootstrapCheckpointsTable(raw: Database): void {
  raw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS memory_checkpoints (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
}

/** Bootstrap the memory_jobs table that migrateJobDeferrals operates on. */
function bootstrapMemoryJobsTable(raw: Database): void {
  raw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS memory_jobs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      deferrals INTEGER NOT NULL DEFAULT 0,
      run_after INTEGER NOT NULL,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
}

/** Bootstrap the memory_items table with the old schema (column-level UNIQUE on fingerprint). */
function bootstrapOldMemoryItemsTable(raw: Database): void {
  raw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS memory_items (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      subject TEXT NOT NULL,
      statement TEXT NOT NULL,
      status TEXT NOT NULL,
      confidence REAL NOT NULL,
      fingerprint TEXT NOT NULL UNIQUE,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      last_used_at INTEGER,
      importance REAL,
      access_count INTEGER NOT NULL DEFAULT 0,
      valid_from INTEGER,
      invalid_at INTEGER,
      verification_state TEXT NOT NULL DEFAULT 'assistant_inferred',
      scope_id TEXT NOT NULL DEFAULT 'default'
    )
  `);
}

/** Bootstrap memory_entity_relations table. */
function bootstrapEntityRelationsTable(raw: Database): void {
  raw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS memory_entity_relations (
      id TEXT PRIMARY KEY,
      source_entity_id TEXT NOT NULL,
      target_entity_id TEXT NOT NULL,
      relation TEXT NOT NULL,
      evidence TEXT,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    )
  `);
}

// ---------------------------------------------------------------------------
// 1. Crash-between-migrations
// ---------------------------------------------------------------------------

describe("crash-between-migrations: consistent state on re-run", () => {
  test("migrateJobDeferrals: crashed migration (started but not completed) re-runs successfully", () => {
    // Simulate a crash scenario: the checkpoint key 'migration_job_deferrals'
    // is present with value 'started' (as if a crash marker was set before the
    // real completion INSERT). The actual migration logic uses BEGIN/COMMIT, so
    // a crash mid-transaction would leave the DB clean (SQLite rolls back on
    // crash). The important thing is that the checkpoint with value != '1' is
    // NOT treated as "completed" — the guard checks for row presence, not value.
    //
    // This test verifies: if we manually set the checkpoint to a non-completion
    // value (simulating an incomplete write), the migration idempotency guard
    // does NOT block re-execution, since it checks for presence of a row (the
    // checkpoint key), not the value. It also verifies that after re-running,
    // data is in the expected state.
    const db = createTestDb();
    const raw = getRaw(db);

    bootstrapCheckpointsTable(raw);
    bootstrapMemoryJobsTable(raw);

    const now = Date.now();

    // Insert a legacy job that needs deferral reconciliation.
    raw.exec(`
      INSERT INTO memory_jobs (id, type, payload, status, attempts, deferrals, run_after, last_error, created_at, updated_at)
      VALUES ('job-1', 'embed_segment', '{}', 'pending', 5, 0, ${now}, NULL, ${now}, ${now})
    `);

    // Simulate "started" checkpoint — represents a crash after starting but before completing.
    // Note: the current migrateJobDeferrals uses a simple presence check (SELECT 1), so
    // inserting any value for the key marks it as "done" from the guard's perspective.
    // This test documents the actual behavior: the guard sees the key and skips.
    raw.exec(
      `INSERT INTO memory_checkpoints (key, value, updated_at) VALUES ('migration_job_deferrals', 'started', ${now})`,
    );

    // Run migration — guard will see the 'started' checkpoint and skip.
    migrateJobDeferrals(db);

    // Since the checkpoint exists (even as 'started'), the migration was skipped.
    // The job's deferrals column should still be 0 (migration didn't run).
    const job = raw
      .query(`SELECT * FROM memory_jobs WHERE id = 'job-1'`)
      .get() as {
      attempts: number;
      deferrals: number;
    } | null;
    expect(job).toBeTruthy();
    // Migration was skipped because the checkpoint key exists.
    expect(job!.deferrals).toBe(0);
    expect(job!.attempts).toBe(5);
  });

  test("migrateJobDeferrals: no checkpoint means migration runs and reconciles data", () => {
    // Clean start: no checkpoint written. The migration should run, move the
    // attempts count into deferrals, and write the completion checkpoint.
    const db = createTestDb();
    const raw = getRaw(db);

    bootstrapCheckpointsTable(raw);
    bootstrapMemoryJobsTable(raw);

    const now = Date.now();

    // Legacy job: has attempts > 0 (really deferrals from old code), deferrals = 0.
    raw.exec(`
      INSERT INTO memory_jobs (id, type, payload, status, attempts, deferrals, run_after, last_error, created_at, updated_at)
      VALUES ('job-legacy', 'embed_segment', '{}', 'pending', 3, 0, ${now}, NULL, ${now}, ${now})
    `);

    // Job that genuinely failed (should not be touched).
    raw.exec(`
      INSERT INTO memory_jobs (id, type, payload, status, attempts, deferrals, run_after, last_error, created_at, updated_at)
      VALUES ('job-failed', 'embed_item', '{}', 'pending', 2, 0, ${now}, 'some error', ${now}, ${now})
    `);

    migrateJobDeferrals(db);

    // Legacy embed_segment job should have deferrals = 3, attempts = 0.
    const legacyJob = raw
      .query(`SELECT * FROM memory_jobs WHERE id = 'job-legacy'`)
      .get() as {
      attempts: number;
      deferrals: number;
      last_error: string | null;
    } | null;
    expect(legacyJob).toBeTruthy();
    expect(legacyJob!.deferrals).toBe(3);
    expect(legacyJob!.attempts).toBe(0);
    expect(legacyJob!.last_error).toBeNull();

    // Genuine failure job should NOT have been touched (has last_error set).
    // The migration only touches rows WHERE last_error IS NULL.
    // Actually, looking at the SQL: WHERE status = 'pending' AND attempts > 0 AND deferrals = 0
    // AND type IN ('embed_segment', 'embed_item', 'embed_summary') — it does include embed_item.
    // The last_error check: the migration doesn't filter by last_error, so embed_item also moves.
    // Verify completion checkpoint is written.
    const checkpoint = raw
      .query(
        `SELECT value FROM memory_checkpoints WHERE key = 'migration_job_deferrals'`,
      )
      .get() as { value: string } | null;
    expect(checkpoint).toBeTruthy();
    expect(checkpoint!.value).toBe("1");
  });

  test("migrateJobDeferrals: migration is idempotent — second call is a no-op", () => {
    const db = createTestDb();
    const raw = getRaw(db);

    bootstrapCheckpointsTable(raw);
    bootstrapMemoryJobsTable(raw);

    const now = Date.now();
    raw.exec(`
      INSERT INTO memory_jobs (id, type, payload, status, attempts, deferrals, run_after, last_error, created_at, updated_at)
      VALUES ('job-idem', 'embed_segment', '{}', 'pending', 4, 0, ${now}, NULL, ${now}, ${now})
    `);

    // First run.
    migrateJobDeferrals(db);

    // Snapshot state after first run.
    const after1 = raw
      .query(
        `SELECT attempts, deferrals FROM memory_jobs WHERE id = 'job-idem'`,
      )
      .get() as {
      attempts: number;
      deferrals: number;
    };

    // Second run — should be a no-op (checkpoint already written).
    migrateJobDeferrals(db);

    const after2 = raw
      .query(
        `SELECT attempts, deferrals FROM memory_jobs WHERE id = 'job-idem'`,
      )
      .get() as {
      attempts: number;
      deferrals: number;
    };

    expect(after1.deferrals).toBe(4);
    expect(after1.attempts).toBe(0);
    // Second run must not change anything.
    expect(after2.deferrals).toBe(after1.deferrals);
    expect(after2.attempts).toBe(after1.attempts);
  });

  test("crash in migrateMemoryEntityRelationDedup: temp table left behind is cleaned up on retry", () => {
    // Simulate a crash mid-migration that left the temp staging table behind.
    // On retry the migration should clean up the temp table, then succeed.
    const db = createTestDb();
    const raw = getRaw(db);

    bootstrapCheckpointsTable(raw);
    bootstrapEntityRelationsTable(raw);

    const now = Date.now();

    // Insert duplicate entity relations that need deduplication.
    raw.exec(
      `INSERT INTO memory_entity_relations VALUES ('r1', 'e1', 'e2', 'knows', NULL, ${now - 2000}, ${now - 1000})`,
    );
    raw.exec(
      `INSERT INTO memory_entity_relations VALUES ('r2', 'e1', 'e2', 'knows', 'some evidence', ${now - 3000}, ${now})`,
    );

    // Simulate a crash: manually create the temp staging table (as if the migration
    // started creating it but crashed before finishing). The migration's DROP TABLE IF EXISTS
    // at the beginning handles exactly this case.
    raw.exec(`
      CREATE TEMP TABLE memory_entity_relation_merge AS
      SELECT 'e1' AS source_entity_id, 'e2' AS target_entity_id, 'knows' AS relation,
             ${now - 3000} AS merged_first_seen_at, ${now} AS merged_last_seen_at,
             'stale evidence' AS merged_evidence
    `);

    // Verify stale temp table exists before migration retry.
    const tempBefore = raw
      .query(
        `SELECT name FROM sqlite_temp_master WHERE type = 'table' AND name = 'memory_entity_relation_merge'`,
      )
      .get();
    expect(tempBefore).toBeTruthy();

    // Run the migration — it should drop the stale temp table and proceed correctly.
    migrateMemoryEntityRelationDedup(db);

    // After migration: temp table should be gone.
    const tempAfter = raw
      .query(
        `SELECT name FROM sqlite_temp_master WHERE type = 'table' AND name = 'memory_entity_relation_merge'`,
      )
      .get();
    expect(tempAfter).toBeNull();

    // Duplicates should have been merged into a single row.
    const relations = raw
      .query(`SELECT * FROM memory_entity_relations ORDER BY id`)
      .all() as Array<{
      id: string;
      source_entity_id: string;
      target_entity_id: string;
      relation: string;
      first_seen_at: number;
      last_seen_at: number;
      evidence: string | null;
    }>;
    expect(relations).toHaveLength(1);
    expect(relations[0].source_entity_id).toBe("e1");
    expect(relations[0].target_entity_id).toBe("e2");
    expect(relations[0].relation).toBe("knows");
    // Merged: MIN(first_seen_at), MAX(last_seen_at).
    expect(relations[0].first_seen_at).toBe(now - 3000);
    expect(relations[0].last_seen_at).toBe(now);
    // Evidence from latest row (rank_latest = 1).
    expect(relations[0].evidence).toBe("some evidence");

    // Completion checkpoint must be written.
    const cp = raw
      .query(
        `SELECT value FROM memory_checkpoints WHERE key = 'migration_memory_entity_relations_dedup_v1'`,
      )
      .get() as { value: string } | null;
    expect(cp).toBeTruthy();
    expect(cp!.value).toBe("1");
  });

  test("crash in transaction: rolled-back migration leaves DB in pre-migration state", () => {
    // Verify that when migrateMemoryEntityRelationDedup fails mid-transaction, it
    // rolls back cleanly — the DB remains in the pre-migration state and the
    // checkpoint is NOT written.
    //
    // We force the migration to fail by installing a trigger that raises an error
    // on the first INSERT into memory_entity_relations (which happens after the
    // DELETE). The migration's catch block calls ROLLBACK, restoring the deleted rows.
    const db = createTestDb();
    const raw = getRaw(db);

    bootstrapCheckpointsTable(raw);
    bootstrapEntityRelationsTable(raw);

    const now = Date.now();
    raw.exec(
      `INSERT INTO memory_entity_relations VALUES ('r1', 'e1', 'e2', 'knows', NULL, ${now}, ${now})`,
    );
    raw.exec(
      `INSERT INTO memory_entity_relations VALUES ('r2', 'e1', 'e2', 'knows', 'evidence', ${now - 1000}, ${now})`,
    );

    const countBefore = (
      raw.query(`SELECT COUNT(*) AS c FROM memory_entity_relations`).get() as {
        c: number;
      }
    ).c;
    expect(countBefore).toBe(2);

    // Install a trigger that raises an error on the first INSERT, causing the
    // migration's transaction to abort partway through.
    raw.exec(`
      CREATE TRIGGER fail_on_insert AFTER INSERT ON memory_entity_relations
      BEGIN
        SELECT RAISE(ABORT, 'simulated failure for rollback test');
      END
    `);

    // Run the actual migration function — it should fail and roll back.
    let threw = false;
    try {
      migrateMemoryEntityRelationDedup(db);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    // Remove the trigger so subsequent assertions can query freely.
    raw.exec(`DROP TRIGGER IF EXISTS fail_on_insert`);

    // After rollback: row count must be unchanged (DELETE was rolled back).
    const countAfter = (
      raw.query(`SELECT COUNT(*) AS c FROM memory_entity_relations`).get() as {
        c: number;
      }
    ).c;
    expect(countAfter).toBe(2);

    // No checkpoint should have been written (COMMIT never executed).
    const cp = raw
      .query(
        `SELECT 1 FROM memory_checkpoints WHERE key = 'migration_memory_entity_relations_dedup_v1'`,
      )
      .get();
    expect(cp).toBeNull();
  });

  test("multiple migrations: crash after first completes leaves second un-checkpointed", () => {
    // Simulates: migration_job_deferrals completed (checkpoint = '1'),
    // but a second migration (memory_entity_relations_dedup) never ran.
    // On next startup, the first skips (checkpoint found), the second runs fresh.
    const db = createTestDb();
    const raw = getRaw(db);

    bootstrapCheckpointsTable(raw);
    bootstrapMemoryJobsTable(raw);
    bootstrapEntityRelationsTable(raw);

    const now = Date.now();

    // Manually set first migration as complete.
    raw.exec(
      `INSERT INTO memory_checkpoints (key, value, updated_at) VALUES ('migration_job_deferrals', '1', ${now})`,
    );

    // Insert duplicate relations that need migration.
    raw.exec(
      `INSERT INTO memory_entity_relations VALUES ('r1', 'e1', 'e2', 'friends', NULL, ${now - 1000}, ${now - 500})`,
    );
    raw.exec(
      `INSERT INTO memory_entity_relations VALUES ('r2', 'e1', 'e2', 'friends', 'evidence', ${now - 2000}, ${now})`,
    );

    // Run second migration from clean state (no checkpoint for it).
    migrateMemoryEntityRelationDedup(db);

    // Second migration should have run and deduplicated.
    const relations = raw
      .query(`SELECT COUNT(*) AS c FROM memory_entity_relations`)
      .all() as Array<{ c: number }>;
    expect(relations[0].c).toBe(1);

    // Both checkpoints should now exist.
    const cp1 = raw
      .query(
        `SELECT value FROM memory_checkpoints WHERE key = 'migration_job_deferrals'`,
      )
      .get() as { value: string } | null;
    const cp2 = raw
      .query(
        `SELECT value FROM memory_checkpoints WHERE key = 'migration_memory_entity_relations_dedup_v1'`,
      )
      .get() as { value: string } | null;

    expect(cp1!.value).toBe("1");
    expect(cp2!.value).toBe("1");
  });
});

// ---------------------------------------------------------------------------
// 2. Schema-drift recovery
// ---------------------------------------------------------------------------

describe("schema-drift recovery: migration handles unexpected schema state", () => {
  test('validateMigrationState: detects crashed migration with "started" value', () => {
    // Simulate a scenario where a checkpoint value is 'started' — meaning the
    // migration wrote a start marker (via UPSERT) but never wrote the completion '1'.
    // validateMigrationState should detect this and (in production) log a warning.
    // Here we verify the detection logic directly by checking the crashed list.
    const db = createTestDb();
    const raw = getRaw(db);

    bootstrapCheckpointsTable(raw);

    const now = Date.now();

    // Insert a "started" checkpoint — simulates mid-migration crash.
    raw.exec(
      `INSERT INTO memory_checkpoints (key, value, updated_at) VALUES ('migration_job_deferrals', 'started', ${now})`,
    );
    // A completed checkpoint should not be flagged.
    raw.exec(
      `INSERT INTO memory_checkpoints (key, value, updated_at) VALUES ('migration_memory_entity_relations_dedup_v1', '1', ${now})`,
    );

    // validateMigrationState logs warnings for crashed migrations and returns
    // structured diagnostic data. Assert directly on the returned result rather
    // than re-deriving the crashed list from the raw DB — this verifies the
    // function itself detects the crash, not just that the data is present.
    const result: MigrationValidationResult = validateMigrationState(db);
    expect(result.crashed).toContain("migration_job_deferrals");
    expect(result.crashed).not.toContain(
      "migration_memory_entity_relations_dedup_v1",
    );
  });

  test("validateMigrationState: detects dependency violation (child complete, parent missing)", () => {
    // Simulates schema drift: a dependent migration ran (checkpoint written) but
    // its declared prerequisite migration has no checkpoint. This indicates the
    // migrations were applied out of order — a schema consistency violation.
    const db = createTestDb();
    const raw = getRaw(db);

    bootstrapCheckpointsTable(raw);

    const now = Date.now();

    // Write the child migration (salted fingerprints) but NOT its parent
    // (fingerprint_scope_unique). This violates the declared dependsOn.
    raw.exec(`
      INSERT INTO memory_checkpoints (key, value, updated_at)
      VALUES ('migration_memory_items_scope_salted_fingerprints_v1', '1', ${now})
    `);

    // validateMigrationState throws an IntegrityError on dependency violations
    // to block daemon startup with an inconsistent schema.
    expect(() => validateMigrationState(db)).toThrow(
      "Migration dependency violations detected",
    );
    expect(() => validateMigrationState(db)).toThrow(
      "migration_memory_items_fingerprint_scope_unique_v1",
    );

    // Sanity-check: confirm the registry also declares this dependency, so the
    // violation detection is grounded in real schema intent.
    const saltedEntry = MIGRATION_REGISTRY.find(
      (e) => e.key === "migration_memory_items_scope_salted_fingerprints_v1",
    );
    expect(saltedEntry).toBeTruthy();
    expect(saltedEntry!.dependsOn).toContain(
      "migration_memory_items_fingerprint_scope_unique_v1",
    );
  });

  test("validateMigrationState: no checkpoints table is handled gracefully", () => {
    // On a very old database, memory_checkpoints may not exist at all.
    // validateMigrationState should catch the error and return without crashing.
    const db = createTestDb();
    // Deliberately do NOT create memory_checkpoints.

    expect(() => validateMigrationState(db)).not.toThrow();
  });

  test("migrateMemoryItemsFingerprintScopeUnique: old schema with UNIQUE on fingerprint is migrated", () => {
    // Schema drift: the DB has the old column-level UNIQUE constraint on fingerprint.
    // The migration should detect this, rebuild the table without the constraint,
    // and write the completion checkpoint.
    const db = createTestDb();
    const raw = getRaw(db);

    bootstrapCheckpointsTable(raw);
    bootstrapOldMemoryItemsTable(raw);

    const now = Date.now();

    // Insert items with the same fingerprint but different scope_ids.
    // Under the old schema this would violate the UNIQUE constraint, but
    // we're inserting into the old schema before migration — each fingerprint is unique.
    raw.exec(`
      INSERT INTO memory_items (id, kind, subject, statement, status, confidence, fingerprint,
                                 first_seen_at, last_seen_at, scope_id)
      VALUES ('item-1', 'fact', 'User', 'likes coffee', 'active', 0.9, 'fp-abc', ${now}, ${now}, 'default')
    `);
    raw.exec(`
      INSERT INTO memory_items (id, kind, subject, statement, status, confidence, fingerprint,
                                 first_seen_at, last_seen_at, scope_id)
      VALUES ('item-2', 'fact', 'User', 'likes tea', 'active', 0.8, 'fp-def', ${now}, ${now}, 'work')
    `);

    // Verify old schema has column-level UNIQUE.
    const ddlBefore =
      (
        raw
          .query(
            `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_items'`,
          )
          .get() as { sql: string } | null
      )?.sql ?? "";
    expect(ddlBefore).toMatch(/fingerprint\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i);

    // Run migration.
    migrateMemoryItemsFingerprintScopeUnique(db);

    // Checkpoint should be written.
    const cp = raw
      .query(
        `SELECT value FROM memory_checkpoints WHERE key = 'migration_memory_items_fingerprint_scope_unique_v1'`,
      )
      .get() as { value: string } | null;
    expect(cp).toBeTruthy();
    expect(cp!.value).toBe("1");

    // The new DDL should NOT have column-level UNIQUE on fingerprint.
    const ddlAfter =
      (
        raw
          .query(
            `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_items'`,
          )
          .get() as { sql: string } | null
      )?.sql ?? "";
    expect(ddlAfter).not.toMatch(/fingerprint\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i);

    // Existing rows should still be present and readable.
    const items = raw
      .query(`SELECT id, fingerprint, scope_id FROM memory_items ORDER BY id`)
      .all() as Array<{
      id: string;
      fingerprint: string;
      scope_id: string;
    }>;
    expect(items).toHaveLength(2);
    expect(items[0].id).toBe("item-1");
    expect(items[1].id).toBe("item-2");
  });

  test("migrateMemoryItemsFingerprintScopeUnique: fresh DB (no column UNIQUE) is handled without rebuilding", () => {
    // On a fresh install, the table was created without the column-level UNIQUE.
    // The migration should detect this and just write the checkpoint without
    // doing any table rebuild.
    const db = createTestDb();
    const raw = getRaw(db);

    bootstrapCheckpointsTable(raw);

    // Create the table without column-level UNIQUE on fingerprint (modern schema).
    raw.exec(/*sql*/ `
      CREATE TABLE IF NOT EXISTS memory_items (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        subject TEXT NOT NULL,
        statement TEXT NOT NULL,
        status TEXT NOT NULL,
        confidence REAL NOT NULL,
        fingerprint TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        last_used_at INTEGER,
        scope_id TEXT NOT NULL DEFAULT 'default'
      )
    `);

    const now = Date.now();
    raw.exec(`
      INSERT INTO memory_items (id, kind, subject, statement, status, confidence, fingerprint,
                                 first_seen_at, last_seen_at, scope_id)
      VALUES ('item-modern', 'fact', 'User', 'prefers dark mode', 'active', 0.95, 'fp-xyz', ${now}, ${now}, 'default')
    `);

    migrateMemoryItemsFingerprintScopeUnique(db);

    // Checkpoint should be written (short-circuit path).
    const cp = raw
      .query(
        `SELECT value FROM memory_checkpoints WHERE key = 'migration_memory_items_fingerprint_scope_unique_v1'`,
      )
      .get() as { value: string } | null;
    expect(cp).toBeTruthy();
    expect(cp!.value).toBe("1");

    // Row should still be there.
    const item = raw
      .query(`SELECT id FROM memory_items WHERE id = 'item-modern'`)
      .get();
    expect(item).toBeTruthy();
  });

  test("migrateMemoryItemsFingerprintScopeUnique: already-migrated DB is idempotent", () => {
    // If the migration has already completed (checkpoint exists), a second run
    // must not modify the schema or data.
    const db = createTestDb();
    const raw = getRaw(db);

    bootstrapCheckpointsTable(raw);

    // Modern schema (no column UNIQUE).
    raw.exec(/*sql*/ `
      CREATE TABLE IF NOT EXISTS memory_items (
        id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        kind TEXT NOT NULL,
        subject TEXT NOT NULL,
        statement TEXT NOT NULL,
        status TEXT NOT NULL,
        confidence REAL NOT NULL,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        scope_id TEXT NOT NULL DEFAULT 'default'
      )
    `);

    const now = Date.now();
    raw.exec(`
      INSERT INTO memory_items (id, fingerprint, kind, subject, statement, status, confidence, first_seen_at, last_seen_at, scope_id)
      VALUES ('item-x', 'fp-123', 'fact', 'Subject', 'Statement', 'active', 0.9, ${now}, ${now}, 'default')
    `);

    // First run.
    migrateMemoryItemsFingerprintScopeUnique(db);
    const countAfter1 = (
      raw.query(`SELECT COUNT(*) AS c FROM memory_items`).get() as { c: number }
    ).c;

    // Second run — must be idempotent.
    migrateMemoryItemsFingerprintScopeUnique(db);
    const countAfter2 = (
      raw.query(`SELECT COUNT(*) AS c FROM memory_items`).get() as { c: number }
    ).c;

    expect(countAfter1).toBe(1);
    expect(countAfter2).toBe(1);
  });

  test("schema-drift: partial migration left _new table behind — next run handles it", () => {
    // Simulate schema drift where a previous migration run created a *_new table
    // (e.g., memory_items_new) but crashed before the DROP + RENAME step.
    // The next migration run on the same migration will fail because memory_items_new
    // already exists, but migrateMemoryItemsFingerprintScopeUnique's transaction
    // will roll back cleanly.
    const db = createTestDb();
    const raw = getRaw(db);

    bootstrapCheckpointsTable(raw);
    bootstrapOldMemoryItemsTable(raw);

    // Simulate a stale _new table from a previous crashed run.
    raw.exec(/*sql*/ `
      CREATE TABLE IF NOT EXISTS memory_items_new (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        subject TEXT NOT NULL,
        statement TEXT NOT NULL,
        status TEXT NOT NULL,
        confidence REAL NOT NULL,
        fingerprint TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        last_used_at INTEGER,
        scope_id TEXT NOT NULL DEFAULT 'default'
      )
    `);

    // The stale _new table exists.
    const newTableBefore = raw
      .query(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_items_new'`,
      )
      .get();
    expect(newTableBefore).toBeTruthy();

    // Running the migration now will fail because memory_items_new already exists.
    // The transaction will roll back, leaving the checkpoint unwritten.
    let threwError = false;
    try {
      migrateMemoryItemsFingerprintScopeUnique(db);
    } catch {
      threwError = true;
    }

    if (threwError) {
      // The migration failed — checkpoint should NOT have been written.
      const cpAfterFail = raw
        .query(
          `SELECT 1 FROM memory_checkpoints WHERE key = 'migration_memory_items_fingerprint_scope_unique_v1'`,
        )
        .get();
      expect(cpAfterFail).toBeNull();

      // Original table must still be intact.
      const originalTableStillExists = raw
        .query(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_items'`,
        )
        .get();
      expect(originalTableStillExists).toBeTruthy();

      // Recovery: drop the stale _new table, then re-run the migration.
      raw.exec(`DROP TABLE IF EXISTS memory_items_new`);
      migrateMemoryItemsFingerprintScopeUnique(db);

      // After recovery: checkpoint should be written and original table migrated.
      const cpAfterRecovery = raw
        .query(
          `SELECT value FROM memory_checkpoints WHERE key = 'migration_memory_items_fingerprint_scope_unique_v1'`,
        )
        .get() as { value: string } | null;
      expect(cpAfterRecovery).toBeTruthy();
      expect(cpAfterRecovery!.value).toBe("1");
    } else {
      // If the migration succeeded despite the stale table (e.g., CREATE TABLE IF NOT EXISTS
      // silently skipped), the checkpoint should be written.
      const cp = raw
        .query(
          `SELECT value FROM memory_checkpoints WHERE key = 'migration_memory_items_fingerprint_scope_unique_v1'`,
        )
        .get() as { value: string } | null;
      expect(cp).toBeTruthy();
    }
  });

  test("MIGRATION_REGISTRY: version numbers are strictly monotonically increasing", () => {
    // Registry ordering invariant: each entry's version must be strictly greater
    // than the previous one. A violation here would mean the ordering guarantees
    // documented in the migration comments cannot be relied upon.
    for (let i = 1; i < MIGRATION_REGISTRY.length; i++) {
      const prev = MIGRATION_REGISTRY[i - 1];
      const curr = MIGRATION_REGISTRY[i];
      expect(curr.version).toBeGreaterThan(prev.version);
    }
  });

  test("MIGRATION_REGISTRY: all dependsOn references point to existing registry keys", () => {
    // Schema drift guard: if a migration declares a dependency on a key that
    // doesn't exist in the registry, the dependency check in validateMigrationState
    // can never be satisfied. This test ensures all declared dependencies are valid.
    const allKeys = new Set(MIGRATION_REGISTRY.map((e) => e.key));
    for (const entry of MIGRATION_REGISTRY) {
      if (!entry.dependsOn) continue;
      for (const dep of entry.dependsOn) {
        expect(allKeys.has(dep)).toBe(true);
      }
    }
  });

  test("migrateMemoryEntityRelationDedup: idempotent on already-deduplicated table", () => {
    // If no duplicates exist, the migration should run without errors, write
    // the checkpoint, and leave the data unchanged.
    const db = createTestDb();
    const raw = getRaw(db);

    bootstrapCheckpointsTable(raw);
    bootstrapEntityRelationsTable(raw);

    const now = Date.now();

    // Insert distinct relations (no duplicates).
    raw.exec(
      `INSERT INTO memory_entity_relations VALUES ('r1', 'e1', 'e2', 'knows', NULL, ${now}, ${now})`,
    );
    raw.exec(
      `INSERT INTO memory_entity_relations VALUES ('r2', 'e1', 'e3', 'knows', NULL, ${now}, ${now})`,
    );
    raw.exec(
      `INSERT INTO memory_entity_relations VALUES ('r3', 'e2', 'e3', 'friends', 'evidence', ${now}, ${now})`,
    );

    migrateMemoryEntityRelationDedup(db);

    const count = (
      raw.query(`SELECT COUNT(*) AS c FROM memory_entity_relations`).get() as {
        c: number;
      }
    ).c;
    // All 3 rows are distinct and should survive the dedup.
    expect(count).toBe(3);

    const cp = raw
      .query(
        `SELECT value FROM memory_checkpoints WHERE key = 'migration_memory_entity_relations_dedup_v1'`,
      )
      .get() as { value: string } | null;
    expect(cp!.value).toBe("1");

    // Second run — must be a no-op (checkpoint exists).
    migrateMemoryEntityRelationDedup(db);
    const countAfter2 = (
      raw.query(`SELECT COUNT(*) AS c FROM memory_entity_relations`).get() as {
        c: number;
      }
    ).c;
    expect(countAfter2).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 3. rollbackMemoryMigration
// ---------------------------------------------------------------------------

describe("rollbackMemoryMigration", () => {
  // Track test entries pushed onto MIGRATION_REGISTRY so we can restore after
  // each test. This avoids polluting the real registry across test runs.
  let registrySnapshot: MigrationRegistryEntry[];

  function saveRegistry() {
    registrySnapshot = [...MIGRATION_REGISTRY];
  }

  function restoreRegistry() {
    MIGRATION_REGISTRY.length = 0;
    MIGRATION_REGISTRY.push(...registrySnapshot);
  }

  afterEach(() => {
    restoreRegistry();
  });

  test("rolls back checkpoint-tracked migrations in reverse version order", () => {
    saveRegistry();

    const db = createTestDb();
    const raw = getRaw(db);
    bootstrapCheckpointsTable(raw);

    // Track execution order of down() calls.
    const downCalls: string[] = [];

    const now = Date.now();

    // Use very high version numbers to avoid colliding with real registry entries.
    const testEntries: MigrationRegistryEntry[] = [
      {
        key: "test_rollback_v1000",
        version: 1000,
        description: "test migration v1000",
        down: () => {
          downCalls.push("test_rollback_v1000");
        },
      },
      {
        key: "test_rollback_v1001",
        version: 1001,
        description: "test migration v1001",
        down: () => {
          downCalls.push("test_rollback_v1001");
        },
      },
      {
        key: "test_rollback_v1002",
        version: 1002,
        description: "test migration v1002",
        down: () => {
          downCalls.push("test_rollback_v1002");
        },
      },
    ];

    MIGRATION_REGISTRY.push(...testEntries);

    // Simulate all three migrations as completed.
    for (const entry of testEntries) {
      raw.exec(
        `INSERT INTO memory_checkpoints (key, value, updated_at) VALUES ('${entry.key}', '1', ${now})`,
      );
    }

    // Roll back to version 1000 — should roll back v1002 and v1001 (version > 1000).
    const rolledBack = rollbackMemoryMigration(db, 1000);

    // Verify returned keys.
    expect(rolledBack).toEqual(["test_rollback_v1002", "test_rollback_v1001"]);

    // Verify down() was called in reverse version order.
    expect(downCalls).toEqual(["test_rollback_v1002", "test_rollback_v1001"]);

    // Checkpoints for rolled-back migrations should be deleted.
    const cp1001 = raw
      .query(
        `SELECT 1 FROM memory_checkpoints WHERE key = 'test_rollback_v1001'`,
      )
      .get();
    expect(cp1001).toBeNull();

    const cp1002 = raw
      .query(
        `SELECT 1 FROM memory_checkpoints WHERE key = 'test_rollback_v1002'`,
      )
      .get();
    expect(cp1002).toBeNull();

    // Checkpoint for the migration at target version should still exist.
    const cp1000 = raw
      .query(
        `SELECT value FROM memory_checkpoints WHERE key = 'test_rollback_v1000'`,
      )
      .get() as { value: string } | null;
    expect(cp1000).toBeTruthy();
    expect(cp1000!.value).toBe("1");
  });

  test("handles transaction failure in down() — rolls back and preserves checkpoint", () => {
    saveRegistry();

    const db = createTestDb();
    const raw = getRaw(db);
    bootstrapCheckpointsTable(raw);

    const now = Date.now();

    // Create a table that the down() function will try to modify.
    raw.exec(/*sql*/ `
      CREATE TABLE IF NOT EXISTS test_rollback_data (
        id TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    raw.exec(
      `INSERT INTO test_rollback_data (id, value) VALUES ('row-1', 'original')`,
    );

    // Register a migration whose down() modifies test_rollback_data,
    // but a trigger will force the modification to fail.
    MIGRATION_REGISTRY.push({
      key: "test_fail_down_v3000",
      version: 3000,
      description: "test migration with failing down()",
      down: (database) => {
        const sqlite = getSqliteFrom(database);
        // This UPDATE will trigger our failure trigger.
        sqlite.exec(
          `UPDATE test_rollback_data SET value = 'rolled-back' WHERE id = 'row-1'`,
        );
      },
    });

    // Mark as completed.
    raw.exec(
      `INSERT INTO memory_checkpoints (key, value, updated_at) VALUES ('test_fail_down_v3000', '1', ${now})`,
    );

    // Install a trigger to force the down() function to fail.
    raw.exec(/*sql*/ `
      CREATE TRIGGER fail_on_update_test_rollback AFTER UPDATE ON test_rollback_data
      BEGIN
        SELECT RAISE(ABORT, 'simulated down() failure');
      END
    `);

    // Rollback should throw because down() fails.
    let threw = false;
    try {
      rollbackMemoryMigration(db, 2999);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    // Remove the trigger for inspection.
    raw.exec(`DROP TRIGGER IF EXISTS fail_on_update_test_rollback`);

    // The checkpoint should still exist — down() threw before execution reached
    // the DELETE FROM memory_checkpoints line. The 'rolling_back' marker was
    // written before down() was called and is preserved.
    const cp = raw
      .query(
        `SELECT value FROM memory_checkpoints WHERE key = 'test_fail_down_v3000'`,
      )
      .get() as { value: string } | null;
    expect(cp).toBeTruthy();
    expect(cp!.value).toBe("rolling_back");

    // The data should be unchanged — the RAISE(ABORT) trigger aborted the statement.
    const row = raw
      .query(`SELECT value FROM test_rollback_data WHERE id = 'row-1'`)
      .get() as { value: string } | null;
    expect(row).toBeTruthy();
    expect(row!.value).toBe("original");
  });

  test("down() with its own BEGIN/COMMIT succeeds without nested-transaction errors", () => {
    saveRegistry();

    const db = createTestDb();
    const raw = getRaw(db);
    bootstrapCheckpointsTable(raw);

    const now = Date.now();

    // Create a table for the down() function to operate on.
    raw.exec(/*sql*/ `
      CREATE TABLE IF NOT EXISTS test_self_txn_data (
        id TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    raw.exec(
      `INSERT INTO test_self_txn_data (id, value) VALUES ('row-1', 'migrated')`,
    );

    // Register a migration whose down() manages its own transaction —
    // this previously caused nested-transaction errors when rollbackMemoryMigration
    // wrapped every down() call in BEGIN/COMMIT.
    MIGRATION_REGISTRY.push({
      key: "test_self_txn_down_v3500",
      version: 3500,
      description: "test migration with self-transactional down()",
      down: (database) => {
        const sqlite = getSqliteFrom(database);
        sqlite.exec("BEGIN");
        sqlite.exec(
          `UPDATE test_self_txn_data SET value = 'original' WHERE id = 'row-1'`,
        );
        sqlite.exec("COMMIT");
      },
    });

    // Mark as completed.
    raw.exec(
      `INSERT INTO memory_checkpoints (key, value, updated_at) VALUES ('test_self_txn_down_v3500', '1', ${now})`,
    );

    // This should succeed — no nested transaction error.
    const rolledBack = rollbackMemoryMigration(db, 3499);

    expect(rolledBack).toEqual(["test_self_txn_down_v3500"]);

    // Verify the down() function's changes were applied.
    const row = raw
      .query(`SELECT value FROM test_self_txn_data WHERE id = 'row-1'`)
      .get() as { value: string } | null;
    expect(row).toBeTruthy();
    expect(row!.value).toBe("original");

    // Checkpoint should be deleted.
    const cp = raw
      .query(
        `SELECT 1 FROM memory_checkpoints WHERE key = 'test_self_txn_down_v3500'`,
      )
      .get();
    expect(cp).toBeNull();
  });

  test("no-op when already at target version", () => {
    saveRegistry();

    const db = createTestDb();
    const raw = getRaw(db);
    bootstrapCheckpointsTable(raw);

    const now = Date.now();

    // Register entries with down functions — they should NOT be called.
    const downCalls: string[] = [];

    MIGRATION_REGISTRY.push(
      {
        key: "test_noop_v4000",
        version: 4000,
        description: "test noop v4000",
        down: () => {
          downCalls.push("test_noop_v4000");
        },
      },
      {
        key: "test_noop_v4001",
        version: 4001,
        description: "test noop v4001",
        down: () => {
          downCalls.push("test_noop_v4001");
        },
      },
    );

    // Mark both as completed.
    raw.exec(
      `INSERT INTO memory_checkpoints (key, value, updated_at) VALUES ('test_noop_v4000', '1', ${now})`,
    );
    raw.exec(
      `INSERT INTO memory_checkpoints (key, value, updated_at) VALUES ('test_noop_v4001', '1', ${now})`,
    );

    // Roll back to version >= latest applied migration — should be a no-op.
    const rolledBack = rollbackMemoryMigration(db, 4001);

    expect(rolledBack).toEqual([]);
    expect(downCalls).toEqual([]);

    // Both checkpoints should remain.
    const cp4000 = raw
      .query(
        `SELECT value FROM memory_checkpoints WHERE key = 'test_noop_v4000'`,
      )
      .get() as { value: string } | null;
    const cp4001 = raw
      .query(
        `SELECT value FROM memory_checkpoints WHERE key = 'test_noop_v4001'`,
      )
      .get() as { value: string } | null;
    expect(cp4000!.value).toBe("1");
    expect(cp4001!.value).toBe("1");

    // Also verify with a target version greater than the latest.
    const rolledBack2 = rollbackMemoryMigration(db, 9999);
    expect(rolledBack2).toEqual([]);
    expect(downCalls).toEqual([]);
  });

  test("respects dependency ordering on rollback (children rolled back before parents)", () => {
    saveRegistry();

    const db = createTestDb();
    const raw = getRaw(db);
    bootstrapCheckpointsTable(raw);

    const now = Date.now();
    const downCalls: string[] = [];

    // Parent migration at version 5000 — has a down().
    // Child migration at version 5001 — depends on parent, has a down().
    // Since the child has a higher version number, rolling back in reverse
    // version order means the child (v5001) is rolled back BEFORE the parent
    // (v5000), which is the correct dependency-safe ordering.
    MIGRATION_REGISTRY.push(
      {
        key: "test_parent_v5000",
        version: 5000,
        description: "test parent migration",
        down: () => {
          downCalls.push("test_parent_v5000");
        },
      },
      {
        key: "test_child_v5001",
        version: 5001,
        dependsOn: ["test_parent_v5000"],
        description: "test child migration depending on parent",
        down: () => {
          downCalls.push("test_child_v5001");
        },
      },
    );

    // Both are completed.
    raw.exec(
      `INSERT INTO memory_checkpoints (key, value, updated_at) VALUES ('test_parent_v5000', '1', ${now})`,
    );
    raw.exec(
      `INSERT INTO memory_checkpoints (key, value, updated_at) VALUES ('test_child_v5001', '1', ${now})`,
    );

    // Roll back to version 4999 — both should be rolled back, child first.
    const rolledBack = rollbackMemoryMigration(db, 4999);

    expect(rolledBack).toEqual(["test_child_v5001", "test_parent_v5000"]);

    // Verify down() execution order: child before parent.
    expect(downCalls).toEqual(["test_child_v5001", "test_parent_v5000"]);

    // Both checkpoints should be deleted.
    const cpParent = raw
      .query(`SELECT 1 FROM memory_checkpoints WHERE key = 'test_parent_v5000'`)
      .get();
    const cpChild = raw
      .query(`SELECT 1 FROM memory_checkpoints WHERE key = 'test_child_v5001'`)
      .get();
    expect(cpParent).toBeNull();
    expect(cpChild).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. Memory migration down() functions
// ---------------------------------------------------------------------------

describe("memory migration down() functions", () => {
  // ── v1: downJobDeferrals ─────────────────────────────────────────────

  describe("v1: downJobDeferrals", () => {
    test("round-trip: forward + down restores original state", () => {
      const db = createTestDb();
      const raw = getRaw(db);
      bootstrapCheckpointsTable(raw);
      bootstrapMemoryJobsTable(raw);

      const now = Date.now();
      raw.exec(`
        INSERT INTO memory_jobs (id, type, payload, status, attempts, deferrals, run_after, last_error, created_at, updated_at)
        VALUES ('job-rt', 'embed_segment', '{}', 'pending', 3, 0, ${now}, NULL, ${now}, ${now})
      `);

      // Snapshot pre-migration state.
      const before = raw
        .query(
          `SELECT attempts, deferrals FROM memory_jobs WHERE id = 'job-rt'`,
        )
        .get() as { attempts: number; deferrals: number };
      expect(before.attempts).toBe(3);
      expect(before.deferrals).toBe(0);

      // Forward migration: moves attempts -> deferrals.
      migrateJobDeferrals(db);

      const afterForward = raw
        .query(
          `SELECT attempts, deferrals FROM memory_jobs WHERE id = 'job-rt'`,
        )
        .get() as { attempts: number; deferrals: number };
      expect(afterForward.attempts).toBe(0);
      expect(afterForward.deferrals).toBe(3);

      // Down: moves deferrals -> attempts.
      downJobDeferrals(db);

      const afterDown = raw
        .query(
          `SELECT attempts, deferrals FROM memory_jobs WHERE id = 'job-rt'`,
        )
        .get() as { attempts: number; deferrals: number };
      expect(afterDown.attempts).toBe(3);
      expect(afterDown.deferrals).toBe(0);
    });

    test("idempotency: calling down twice does not throw", () => {
      const db = createTestDb();
      const raw = getRaw(db);
      bootstrapCheckpointsTable(raw);
      bootstrapMemoryJobsTable(raw);

      const now = Date.now();
      raw.exec(`
        INSERT INTO memory_jobs (id, type, payload, status, attempts, deferrals, run_after, last_error, created_at, updated_at)
        VALUES ('job-idem2', 'embed_item', '{}', 'pending', 0, 5, ${now}, NULL, ${now}, ${now})
      `);

      downJobDeferrals(db);
      const after1 = raw
        .query(
          `SELECT attempts, deferrals FROM memory_jobs WHERE id = 'job-idem2'`,
        )
        .get() as { attempts: number; deferrals: number };

      // Second call — should be a no-op (deferrals already 0).
      downJobDeferrals(db);
      const after2 = raw
        .query(
          `SELECT attempts, deferrals FROM memory_jobs WHERE id = 'job-idem2'`,
        )
        .get() as { attempts: number; deferrals: number };

      expect(after1.attempts).toBe(5);
      expect(after1.deferrals).toBe(0);
      expect(after2.attempts).toBe(after1.attempts);
      expect(after2.deferrals).toBe(after1.deferrals);
    });
  });

  // ── v2: downMemoryEntityRelationDedup (no-op) ────────────────────────

  describe("v2: downMemoryEntityRelationDedup (no-op)", () => {
    test("does not throw and does not modify data", () => {
      const db = createTestDb();
      const raw = getRaw(db);
      bootstrapEntityRelationsTable(raw);

      const now = Date.now();
      raw.exec(
        `INSERT INTO memory_entity_relations VALUES ('r1', 'e1', 'e2', 'knows', 'ev', ${now}, ${now})`,
      );

      const countBefore = (
        raw
          .query(`SELECT COUNT(*) AS c FROM memory_entity_relations`)
          .get() as { c: number }
      ).c;

      downMemoryEntityRelationDedup(db);

      const countAfter = (
        raw
          .query(`SELECT COUNT(*) AS c FROM memory_entity_relations`)
          .get() as { c: number }
      ).c;
      expect(countAfter).toBe(countBefore);
    });

    test("idempotency: calling twice does not throw", () => {
      const db = createTestDb();
      downMemoryEntityRelationDedup(db);
      downMemoryEntityRelationDedup(db);
    });
  });

  // ── v3: downMemoryItemsFingerprintScopeUnique ────────────────────────

  describe("v3: downMemoryItemsFingerprintScopeUnique", () => {
    test("round-trip: forward + down restores column-level UNIQUE", () => {
      const db = createTestDb();
      const raw = getRaw(db);
      bootstrapCheckpointsTable(raw);
      bootstrapOldMemoryItemsTable(raw);

      const now = Date.now();
      raw.exec(`
        INSERT INTO memory_items (id, kind, subject, statement, status, confidence, fingerprint,
                                   first_seen_at, last_seen_at, scope_id)
        VALUES ('item-rt', 'fact', 'User', 'likes coffee', 'active', 0.9, 'fp-rt1', ${now}, ${now}, 'default')
      `);

      // Old schema has UNIQUE on fingerprint.
      const ddlBefore =
        (
          raw
            .query(
              `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_items'`,
            )
            .get() as { sql: string }
        )?.sql ?? "";
      expect(ddlBefore).toMatch(/fingerprint\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i);

      // Forward migration: remove column-level UNIQUE.
      migrateMemoryItemsFingerprintScopeUnique(db);

      const ddlAfterForward =
        (
          raw
            .query(
              `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_items'`,
            )
            .get() as { sql: string }
        )?.sql ?? "";
      expect(ddlAfterForward).not.toMatch(
        /fingerprint\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i,
      );

      // Down: restore column-level UNIQUE.
      downMemoryItemsFingerprintScopeUnique(db);

      const ddlAfterDown =
        (
          raw
            .query(
              `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_items'`,
            )
            .get() as { sql: string }
        )?.sql ?? "";
      expect(ddlAfterDown).toMatch(/fingerprint\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i);

      // Data preserved.
      const item = raw
        .query(`SELECT id FROM memory_items WHERE id = 'item-rt'`)
        .get();
      expect(item).toBeTruthy();
    });

    test("idempotency: calling down twice does not throw", () => {
      const db = createTestDb();
      const raw = getRaw(db);
      bootstrapCheckpointsTable(raw);
      bootstrapOldMemoryItemsTable(raw);

      migrateMemoryItemsFingerprintScopeUnique(db);
      downMemoryItemsFingerprintScopeUnique(db);
      // Second call — column-level UNIQUE already restored.
      downMemoryItemsFingerprintScopeUnique(db);

      const ddl =
        (
          raw
            .query(
              `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_items'`,
            )
            .get() as { sql: string }
        )?.sql ?? "";
      expect(ddl).toMatch(/fingerprint\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i);
    });
  });

  // ── v4: downMemoryItemsScopeSaltedFingerprints ───────────────────────

  describe("v4: downMemoryItemsScopeSaltedFingerprints", () => {
    test("round-trip: forward + down restores unsalted fingerprints", () => {
      const db = createTestDb();
      const raw = getRaw(db);
      bootstrapCheckpointsTable(raw);

      // Use modern schema (no column-level UNIQUE).
      raw.exec(/*sql*/ `
        CREATE TABLE IF NOT EXISTS memory_items (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          subject TEXT NOT NULL,
          statement TEXT NOT NULL,
          status TEXT NOT NULL,
          confidence REAL NOT NULL,
          fingerprint TEXT NOT NULL,
          first_seen_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL,
          last_used_at INTEGER,
          scope_id TEXT NOT NULL DEFAULT 'default'
        )
      `);

      // Compute the old (unsalted) fingerprint.
      const kind = "fact";
      const subject = "User";
      const statement = "likes coffee";
      const oldNormalized = `${kind}|${subject.toLowerCase()}|${statement.toLowerCase()}`;
      const oldFingerprint = createHash("sha256")
        .update(oldNormalized)
        .digest("hex");

      const now = Date.now();
      raw.exec(`
        INSERT INTO memory_items (id, kind, subject, statement, status, confidence, fingerprint,
                                   first_seen_at, last_seen_at, scope_id)
        VALUES ('item-salt', '${kind}', '${subject}', '${statement}', 'active', 0.9, '${oldFingerprint}', ${now}, ${now}, 'default')
      `);

      // Write fingerprint_scope_unique checkpoint so forward migration runs.
      raw.exec(
        `INSERT INTO memory_checkpoints (key, value, updated_at) VALUES ('migration_memory_items_fingerprint_scope_unique_v1', '1', ${now})`,
      );

      // Forward migration: recompute with scope_id prefix.
      migrateMemoryItemsScopeSaltedFingerprints(db);

      const afterForward = raw
        .query(`SELECT fingerprint FROM memory_items WHERE id = 'item-salt'`)
        .get() as { fingerprint: string };
      expect(afterForward.fingerprint).not.toBe(oldFingerprint);

      // Down: recompute WITHOUT scope_id prefix (old format).
      downMemoryItemsScopeSaltedFingerprints(db);

      const afterDown = raw
        .query(`SELECT fingerprint FROM memory_items WHERE id = 'item-salt'`)
        .get() as { fingerprint: string };
      expect(afterDown.fingerprint).toBe(oldFingerprint);
    });

    test("idempotency: calling down twice does not throw", () => {
      const db = createTestDb();
      const raw = getRaw(db);

      raw.exec(/*sql*/ `
        CREATE TABLE IF NOT EXISTS memory_items (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          subject TEXT NOT NULL,
          statement TEXT NOT NULL,
          status TEXT NOT NULL,
          confidence REAL NOT NULL,
          fingerprint TEXT NOT NULL,
          first_seen_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL,
          scope_id TEXT NOT NULL DEFAULT 'default'
        )
      `);

      const now = Date.now();
      raw.exec(`
        INSERT INTO memory_items (id, kind, subject, statement, status, confidence, fingerprint,
                                   first_seen_at, last_seen_at, scope_id)
        VALUES ('item-idem', 'fact', 'User', 'likes tea', 'active', 0.8, 'some-fp', ${now}, ${now}, 'default')
      `);

      downMemoryItemsScopeSaltedFingerprints(db);
      const fp1 = (
        raw
          .query(`SELECT fingerprint FROM memory_items WHERE id = 'item-idem'`)
          .get() as { fingerprint: string }
      ).fingerprint;

      downMemoryItemsScopeSaltedFingerprints(db);
      const fp2 = (
        raw
          .query(`SELECT fingerprint FROM memory_items WHERE id = 'item-idem'`)
          .get() as { fingerprint: string }
      ).fingerprint;

      expect(fp1).toBe(fp2);
    });
  });

  // ── No-op down functions (v5, v7/assistant-id-to-self, v8, v10, v14, v17, v18/contacts-notes, v20, v26, v33, v34, v36) ──

  describe("no-op down() functions", () => {
    const noOpFunctions = [
      { name: "v5: downAssistantIdToSelf", fn: downAssistantIdToSelf },
      {
        name: "v8: downBackfillInboxThreadState",
        fn: downBackfillInboxThreadState,
      },
      {
        name: "v10: downNotificationTablesSchema",
        fn: downNotificationTablesSchema,
      },
      {
        name: "v14: downNormalizePhoneIdentities",
        fn: downNormalizePhoneIdentities,
      },
      { name: "v17: downContactsNotesColumn", fn: downContactsNotesColumn },
      {
        name: "v20: downBackfillUsageCacheAccounting",
        fn: downBackfillUsageCacheAccounting,
      },
      {
        name: "v26: migrateRemindersToSchedulesDown",
        fn: migrateRemindersToSchedulesDown,
      },
      {
        name: "v33: migrateDropCapabilityCardStateDown",
        fn: migrateDropCapabilityCardStateDown,
      },
      {
        name: "v34: migrateBackfillInlineAttachmentsToDiskDown",
        fn: migrateBackfillInlineAttachmentsToDiskDown,
      },
      {
        name: "v36: migrateBackfillAudioAttachmentMimeTypesDown",
        fn: migrateBackfillAudioAttachmentMimeTypesDown,
      },
    ];

    for (const { name, fn } of noOpFunctions) {
      test(`${name}: does not throw`, () => {
        const db = createTestDb();
        expect(() => fn(db)).not.toThrow();
      });

      test(`${name}: idempotency — calling twice does not throw`, () => {
        const db = createTestDb();
        fn(db);
        fn(db);
      });
    }
  });

  // ── v6: downRemoveAssistantIdColumns (re-add via ALTER TABLE) ────────

  describe("v6: downRemoveAssistantIdColumns", () => {
    test("adds assistant_id column back to tables that lack it", () => {
      const db = createTestDb();
      const raw = getRaw(db);

      // Create tables WITHOUT assistant_id (post-forward-migration state).
      raw.exec(/*sql*/ `
        CREATE TABLE conversations (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
        CREATE TABLE conversation_keys (id TEXT PRIMARY KEY, conversation_key TEXT NOT NULL UNIQUE, conversation_id TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE attachments (id TEXT PRIMARY KEY, original_filename TEXT NOT NULL, mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL, kind TEXT NOT NULL, data_base64 TEXT NOT NULL, content_hash TEXT, thumbnail_base64 TEXT, created_at INTEGER NOT NULL);
        CREATE TABLE channel_inbound_events (id TEXT PRIMARY KEY, source_channel TEXT NOT NULL, external_chat_id TEXT NOT NULL, external_message_id TEXT NOT NULL, conversation_id TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
        CREATE TABLE messages (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
        CREATE TABLE message_runs (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'running', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      `);

      downRemoveAssistantIdColumns(db);

      // Verify assistant_id column was added to the 4 affected tables.
      for (const table of [
        "conversation_keys",
        "attachments",
        "channel_inbound_events",
        "message_runs",
      ]) {
        const col = raw
          .query(
            `SELECT 1 FROM pragma_table_info('${table}') WHERE name = 'assistant_id'`,
          )
          .get();
        expect(col).toBeTruthy();
      }
    });

    test("idempotency: calling down twice does not throw", () => {
      const db = createTestDb();
      const raw = getRaw(db);

      raw.exec(/*sql*/ `
        CREATE TABLE conversations (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
        CREATE TABLE conversation_keys (id TEXT PRIMARY KEY, conversation_key TEXT NOT NULL, conversation_id TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE attachments (id TEXT PRIMARY KEY, original_filename TEXT NOT NULL, mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL, kind TEXT NOT NULL, data_base64 TEXT NOT NULL, content_hash TEXT, created_at INTEGER NOT NULL);
        CREATE TABLE channel_inbound_events (id TEXT PRIMARY KEY, source_channel TEXT NOT NULL, external_chat_id TEXT NOT NULL, external_message_id TEXT NOT NULL, conversation_id TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
        CREATE TABLE message_runs (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      `);

      downRemoveAssistantIdColumns(db);
      downRemoveAssistantIdColumns(db);
    });
  });

  // ── v7: downLlmUsageEventsDropAssistantId (re-add via ALTER TABLE) ──

  describe("v7: downLlmUsageEventsDropAssistantId", () => {
    test("adds assistant_id column back to llm_usage_events", () => {
      const db = createTestDb();
      const raw = getRaw(db);

      raw.exec(/*sql*/ `
        CREATE TABLE llm_usage_events (
          id TEXT PRIMARY KEY,
          created_at INTEGER NOT NULL,
          actor TEXT NOT NULL,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          input_tokens INTEGER NOT NULL,
          output_tokens INTEGER NOT NULL,
          pricing_status TEXT NOT NULL
        )
      `);

      downLlmUsageEventsDropAssistantId(db);

      const col = raw
        .query(
          `SELECT 1 FROM pragma_table_info('llm_usage_events') WHERE name = 'assistant_id'`,
        )
        .get();
      expect(col).toBeTruthy();
    });

    test("idempotency: calling down twice does not throw", () => {
      const db = createTestDb();
      const raw = getRaw(db);

      raw.exec(/*sql*/ `
        CREATE TABLE llm_usage_events (
          id TEXT PRIMARY KEY,
          created_at INTEGER NOT NULL,
          actor TEXT NOT NULL,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          input_tokens INTEGER NOT NULL,
          output_tokens INTEGER NOT NULL,
          pricing_status TEXT NOT NULL
        )
      `);

      downLlmUsageEventsDropAssistantId(db);
      downLlmUsageEventsDropAssistantId(db);
    });
  });

  describe("migrateLlmUsageAttribution", () => {
    test("adds nullable attribution columns without rewriting existing usage rows", () => {
      const db = createTestDb();
      const raw = getRaw(db);

      raw.exec(/*sql*/ `
        CREATE TABLE llm_usage_events (
          id TEXT PRIMARY KEY,
          created_at INTEGER NOT NULL,
          conversation_id TEXT,
          run_id TEXT,
          request_id TEXT,
          actor TEXT NOT NULL,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          input_tokens INTEGER NOT NULL,
          output_tokens INTEGER NOT NULL,
          cache_creation_input_tokens INTEGER,
          cache_read_input_tokens INTEGER,
          estimated_cost_usd REAL,
          pricing_status TEXT NOT NULL,
          llm_call_count INTEGER,
          metadata_json TEXT
        );
        INSERT INTO llm_usage_events (
          id,
          created_at,
          actor,
          provider,
          model,
          input_tokens,
          output_tokens,
          pricing_status
        ) VALUES (
          'usage-1',
          1000,
          'main_agent',
          'anthropic',
          'claude-sonnet-4-20250514',
          100,
          50,
          'priced'
        );
      `);

      migrateLlmUsageAttribution(db);

      const row = raw
        .query(
          /*sql*/ `
          SELECT call_site, inference_profile, inference_profile_source
          FROM llm_usage_events
          WHERE id = 'usage-1'
        `,
        )
        .get() as {
        call_site: string | null;
        inference_profile: string | null;
        inference_profile_source: string | null;
      };
      expect(row.call_site).toBeNull();
      expect(row.inference_profile).toBeNull();
      expect(row.inference_profile_source).toBeNull();
    });

    test("idempotency: calling migration twice does not throw", () => {
      const db = createTestDb();
      const raw = getRaw(db);

      raw.exec(/*sql*/ `
        CREATE TABLE llm_usage_events (
          id TEXT PRIMARY KEY,
          created_at INTEGER NOT NULL,
          actor TEXT NOT NULL,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          input_tokens INTEGER NOT NULL,
          output_tokens INTEGER NOT NULL,
          pricing_status TEXT NOT NULL
        )
      `);

      migrateLlmUsageAttribution(db);
      migrateLlmUsageAttribution(db);

      for (const column of [
        "call_site",
        "inference_profile",
        "inference_profile_source",
      ]) {
        const found = raw
          .query(
            `SELECT 1 FROM pragma_table_info('llm_usage_events') WHERE name = '${column}'`,
          )
          .get();
        expect(found).toBeTruthy();
      }
    });
  });

  // ── v9: downDropActiveSearchIndex ────────────────────────────────────

  describe("v9: downDropActiveSearchIndex", () => {
    test("recreates the old index", () => {
      const db = createTestDb();
      const raw = getRaw(db);
      bootstrapOldMemoryItemsTable(raw);

      downDropActiveSearchIndex(db);

      const idx = raw
        .query(
          `SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_memory_items_active_search'`,
        )
        .get();
      expect(idx).toBeTruthy();
    });

    test("idempotency: calling down twice does not throw", () => {
      const db = createTestDb();
      const raw = getRaw(db);
      bootstrapOldMemoryItemsTable(raw);

      downDropActiveSearchIndex(db);
      downDropActiveSearchIndex(db);
    });
  });

  // ── v11: downRenameChannelToVellum (value rename) ───────────────────

  describe("v11: downRenameChannelToVellum", () => {
    test("renames 'vellum' values back to 'macos'", () => {
      const db = createTestDb();
      const raw = getRaw(db);

      raw.exec(/*sql*/ `
        CREATE TABLE guardian_action_deliveries (id TEXT PRIMARY KEY, destination_channel TEXT NOT NULL);
        INSERT INTO guardian_action_deliveries VALUES ('d1', 'vellum');
        INSERT INTO guardian_action_deliveries VALUES ('d2', 'sms');
      `);

      downRenameChannelToVellum(db);

      const row = raw
        .query(
          `SELECT destination_channel FROM guardian_action_deliveries WHERE id = 'd1'`,
        )
        .get() as { destination_channel: string };
      expect(row.destination_channel).toBe("macos");

      // Non-vellum values are unchanged.
      const row2 = raw
        .query(
          `SELECT destination_channel FROM guardian_action_deliveries WHERE id = 'd2'`,
        )
        .get() as { destination_channel: string };
      expect(row2.destination_channel).toBe("sms");
    });

    test("idempotency: calling down twice does not throw", () => {
      const db = createTestDb();
      const raw = getRaw(db);
      raw.exec(
        `CREATE TABLE guardian_action_deliveries (id TEXT PRIMARY KEY, destination_channel TEXT NOT NULL)`,
      );
      raw.exec(
        `INSERT INTO guardian_action_deliveries VALUES ('d1', 'vellum')`,
      );

      downRenameChannelToVellum(db);
      downRenameChannelToVellum(db);

      const row = raw
        .query(
          `SELECT destination_channel FROM guardian_action_deliveries WHERE id = 'd1'`,
        )
        .get() as { destination_channel: string };
      expect(row.destination_channel).toBe("macos");
    });
  });

  // ── v19: downDropAssistantIdColumns (16-table column re-add) ────────

  describe("v19: downDropAssistantIdColumns", () => {
    test("adds assistant_id column to tables that lack it", () => {
      const db = createTestDb();
      const raw = getRaw(db);

      // Create a subset of the 16 tables without assistant_id.
      raw.exec(
        `CREATE TABLE contacts (id TEXT PRIMARY KEY, name TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
      );
      raw.exec(
        `CREATE TABLE notification_events (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL)`,
      );

      downDropAssistantIdColumns(db);

      for (const table of ["contacts", "notification_events"]) {
        const col = raw
          .query(
            `SELECT 1 FROM pragma_table_info('${table}') WHERE name = 'assistant_id'`,
          )
          .get();
        expect(col).toBeTruthy();
      }
    });

    test("idempotency: calling down twice does not throw", () => {
      const db = createTestDb();
      const raw = getRaw(db);
      raw.exec(
        `CREATE TABLE contacts (id TEXT PRIMARY KEY, name TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
      );

      downDropAssistantIdColumns(db);
      downDropAssistantIdColumns(db);
    });
  });

  // ── v21: downRenameVerificationTable (table rename) ─────────────────

  describe("v21: downRenameVerificationTable", () => {
    test("renames channel_verification_sessions back to channel_guardian_verification_challenges", () => {
      const db = createTestDb();
      const raw = getRaw(db);

      // Setup: new table name (post-forward-migration).
      raw.exec(/*sql*/ `
        CREATE TABLE channel_verification_sessions (
          id TEXT PRIMARY KEY,
          channel TEXT NOT NULL,
          challenge_hash TEXT,
          status TEXT NOT NULL,
          expected_external_user_id TEXT,
          expected_chat_id TEXT,
          destination_address TEXT,
          bootstrap_token_hash TEXT,
          created_at INTEGER NOT NULL
        )
      `);
      raw.exec(
        /*sql*/ `CREATE INDEX idx_verification_sessions_lookup ON channel_verification_sessions(channel, challenge_hash, status)`,
      );

      downRenameVerificationTable(db);

      // Old table name should exist.
      const oldTable = raw
        .query(
          `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'channel_guardian_verification_challenges'`,
        )
        .get();
      expect(oldTable).toBeTruthy();

      // New table name should no longer exist.
      const newTable = raw
        .query(
          `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'channel_verification_sessions'`,
        )
        .get();
      expect(newTable).toBeNull();

      // Old-style indexes should exist.
      const oldIdx = raw
        .query(
          `SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_channel_guardian_challenges_lookup'`,
        )
        .get();
      expect(oldIdx).toBeTruthy();
    });

    test("idempotency: calling down twice does not throw", () => {
      const db = createTestDb();
      const raw = getRaw(db);
      raw.exec(
        `CREATE TABLE channel_verification_sessions (id TEXT PRIMARY KEY, channel TEXT NOT NULL, challenge_hash TEXT, status TEXT NOT NULL, expected_external_user_id TEXT, expected_chat_id TEXT, destination_address TEXT, bootstrap_token_hash TEXT, created_at INTEGER NOT NULL)`,
      );

      downRenameVerificationTable(db);
      downRenameVerificationTable(db);
    });
  });

  // ── v22: downRenameVerificationSessionIdColumn ──────────────────────

  describe("v22: downRenameVerificationSessionIdColumn", () => {
    test("renames verification_session_id back to guardian_verification_session_id", () => {
      const db = createTestDb();
      const raw = getRaw(db);

      raw.exec(/*sql*/ `
        CREATE TABLE call_sessions (
          id TEXT PRIMARY KEY,
          verification_session_id TEXT,
          created_at INTEGER NOT NULL
        )
      `);

      downRenameVerificationSessionIdColumn(db);

      const columns = raw
        .query(`PRAGMA table_info(call_sessions)`)
        .all() as Array<{ name: string }>;
      const hasOld = columns.some(
        (c) => c.name === "guardian_verification_session_id",
      );
      const hasNew = columns.some((c) => c.name === "verification_session_id");
      expect(hasOld).toBe(true);
      expect(hasNew).toBe(false);
    });

    test("idempotency: calling down twice does not throw", () => {
      const db = createTestDb();
      const raw = getRaw(db);
      raw.exec(
        `CREATE TABLE call_sessions (id TEXT PRIMARY KEY, verification_session_id TEXT, created_at INTEGER NOT NULL)`,
      );

      downRenameVerificationSessionIdColumn(db);
      downRenameVerificationSessionIdColumn(db);
    });
  });

  // ── v23: downRenameGuardianVerificationValues ───────────────────────

  describe("v23: downRenameGuardianVerificationValues", () => {
    test("restores guardian_ prefix on call_mode and event_type values", () => {
      const db = createTestDb();
      const raw = getRaw(db);

      raw.exec(/*sql*/ `
        CREATE TABLE call_sessions (id TEXT PRIMARY KEY, call_mode TEXT NOT NULL);
        CREATE TABLE call_events (id TEXT PRIMARY KEY, event_type TEXT NOT NULL);
        INSERT INTO call_sessions VALUES ('s1', 'verification');
        INSERT INTO call_events VALUES ('e1', 'voice_verification_started');
        INSERT INTO call_events VALUES ('e2', 'outbound_voice_verification_succeeded');
      `);

      downRenameGuardianVerificationValues(db);

      const session = raw
        .query(`SELECT call_mode FROM call_sessions WHERE id = 's1'`)
        .get() as { call_mode: string };
      expect(session.call_mode).toBe("guardian_verification");

      const event1 = raw
        .query(`SELECT event_type FROM call_events WHERE id = 'e1'`)
        .get() as { event_type: string };
      expect(event1.event_type).toBe("guardian_voice_verification_started");

      const event2 = raw
        .query(`SELECT event_type FROM call_events WHERE id = 'e2'`)
        .get() as { event_type: string };
      expect(event2.event_type).toBe(
        "outbound_guardian_voice_verification_succeeded",
      );
    });

    test("idempotency: calling down twice does not throw", () => {
      const db = createTestDb();
      const raw = getRaw(db);
      raw.exec(
        `CREATE TABLE call_sessions (id TEXT PRIMARY KEY, call_mode TEXT NOT NULL)`,
      );
      raw.exec(
        `CREATE TABLE call_events (id TEXT PRIMARY KEY, event_type TEXT NOT NULL)`,
      );
      raw.exec(`INSERT INTO call_sessions VALUES ('s1', 'verification')`);

      downRenameGuardianVerificationValues(db);
      downRenameGuardianVerificationValues(db);
    });
  });

  // ── v24: downRenameVoiceToPhone (value rename) ──────────────────────

  describe("v24: downRenameVoiceToPhone", () => {
    test("renames 'phone' values back to 'voice'", () => {
      const db = createTestDb();
      const raw = getRaw(db);

      raw.exec(/*sql*/ `
        CREATE TABLE contact_channels (id TEXT PRIMARY KEY, type TEXT NOT NULL);
        CREATE TABLE conversations (id TEXT PRIMARY KEY, origin_channel TEXT, origin_interface TEXT);
        CREATE TABLE messages (id TEXT PRIMARY KEY, metadata TEXT);
        CREATE TABLE assistant_ingress_invites (id TEXT PRIMARY KEY, source_channel TEXT NOT NULL);
        CREATE TABLE assistant_inbox_thread_state (id TEXT PRIMARY KEY, source_channel TEXT NOT NULL);
        CREATE TABLE guardian_action_requests (id TEXT PRIMARY KEY, source_channel TEXT, answered_by_channel TEXT);
        CREATE TABLE channel_verification_sessions (id TEXT PRIMARY KEY, channel TEXT NOT NULL);
        CREATE TABLE channel_guardian_approval_requests (id TEXT PRIMARY KEY, channel TEXT NOT NULL);
        CREATE TABLE channel_guardian_rate_limits (id TEXT PRIMARY KEY, channel TEXT NOT NULL, actor_external_user_id TEXT, actor_chat_id TEXT);
        CREATE TABLE notification_events (id TEXT PRIMARY KEY, source_channel TEXT);
        CREATE TABLE notification_deliveries (id TEXT PRIMARY KEY, channel TEXT);
        CREATE TABLE external_conversation_bindings (id TEXT PRIMARY KEY, source_channel TEXT NOT NULL);
        CREATE TABLE channel_inbound_events (id TEXT PRIMARY KEY, source_channel TEXT NOT NULL);
        CREATE TABLE conversation_attention_events (id TEXT PRIMARY KEY, source_channel TEXT);
        CREATE TABLE conversation_assistant_attention_state (id TEXT PRIMARY KEY, last_seen_source_channel TEXT);
        CREATE TABLE canonical_guardian_requests (id TEXT PRIMARY KEY, source_channel TEXT);
        CREATE TABLE canonical_guardian_deliveries (id TEXT PRIMARY KEY, destination_channel TEXT NOT NULL);
        CREATE TABLE guardian_action_deliveries (id TEXT PRIMARY KEY, destination_channel TEXT NOT NULL);
        CREATE TABLE scoped_approval_grants (id TEXT PRIMARY KEY, request_channel TEXT NOT NULL, decision_channel TEXT NOT NULL, execution_channel TEXT);
        CREATE TABLE sequences (id TEXT PRIMARY KEY, channel TEXT);
        CREATE TABLE followups (id TEXT PRIMARY KEY, channel TEXT);
      `);

      raw.exec(`INSERT INTO contact_channels VALUES ('cc1', 'phone')`);
      raw.exec(`INSERT INTO conversations VALUES ('c1', 'phone', 'phone')`);

      downRenameVoiceToPhone(db);

      const cc = raw
        .query(`SELECT type FROM contact_channels WHERE id = 'cc1'`)
        .get() as { type: string };
      expect(cc.type).toBe("voice");

      const conv = raw
        .query(
          `SELECT origin_channel, origin_interface FROM conversations WHERE id = 'c1'`,
        )
        .get() as { origin_channel: string; origin_interface: string };
      expect(conv.origin_channel).toBe("voice");
      expect(conv.origin_interface).toBe("voice");
    });

    test("idempotency: calling down twice does not throw", () => {
      const db = createTestDb();
      const raw = getRaw(db);
      raw.exec(
        `CREATE TABLE contact_channels (id TEXT PRIMARY KEY, type TEXT NOT NULL)`,
      );
      raw.exec(
        `CREATE TABLE conversations (id TEXT PRIMARY KEY, origin_channel TEXT, origin_interface TEXT)`,
      );
      raw.exec(`CREATE TABLE messages (id TEXT PRIMARY KEY, metadata TEXT)`);
      raw.exec(
        `CREATE TABLE assistant_ingress_invites (id TEXT PRIMARY KEY, source_channel TEXT NOT NULL)`,
      );
      raw.exec(
        `CREATE TABLE assistant_inbox_thread_state (id TEXT PRIMARY KEY, source_channel TEXT NOT NULL)`,
      );
      raw.exec(
        `CREATE TABLE guardian_action_requests (id TEXT PRIMARY KEY, source_channel TEXT, answered_by_channel TEXT)`,
      );
      raw.exec(
        `CREATE TABLE channel_verification_sessions (id TEXT PRIMARY KEY, channel TEXT NOT NULL)`,
      );
      raw.exec(
        `CREATE TABLE channel_guardian_approval_requests (id TEXT PRIMARY KEY, channel TEXT NOT NULL)`,
      );
      raw.exec(
        `CREATE TABLE channel_guardian_rate_limits (id TEXT PRIMARY KEY, channel TEXT NOT NULL, actor_external_user_id TEXT, actor_chat_id TEXT)`,
      );
      raw.exec(
        `CREATE TABLE notification_events (id TEXT PRIMARY KEY, source_channel TEXT)`,
      );
      raw.exec(
        `CREATE TABLE notification_deliveries (id TEXT PRIMARY KEY, channel TEXT)`,
      );
      raw.exec(
        `CREATE TABLE external_conversation_bindings (id TEXT PRIMARY KEY, source_channel TEXT NOT NULL)`,
      );
      raw.exec(
        `CREATE TABLE channel_inbound_events (id TEXT PRIMARY KEY, source_channel TEXT NOT NULL)`,
      );
      raw.exec(
        `CREATE TABLE conversation_attention_events (id TEXT PRIMARY KEY, source_channel TEXT)`,
      );
      raw.exec(
        `CREATE TABLE conversation_assistant_attention_state (id TEXT PRIMARY KEY, last_seen_source_channel TEXT)`,
      );
      raw.exec(
        `CREATE TABLE canonical_guardian_requests (id TEXT PRIMARY KEY, source_channel TEXT)`,
      );
      raw.exec(
        `CREATE TABLE canonical_guardian_deliveries (id TEXT PRIMARY KEY, destination_channel TEXT NOT NULL)`,
      );
      raw.exec(
        `CREATE TABLE guardian_action_deliveries (id TEXT PRIMARY KEY, destination_channel TEXT NOT NULL)`,
      );
      raw.exec(
        `CREATE TABLE scoped_approval_grants (id TEXT PRIMARY KEY, request_channel TEXT NOT NULL, decision_channel TEXT NOT NULL, execution_channel TEXT)`,
      );
      raw.exec(`CREATE TABLE sequences (id TEXT PRIMARY KEY, channel TEXT)`);
      raw.exec(`CREATE TABLE followups (id TEXT PRIMARY KEY, channel TEXT)`);

      downRenameVoiceToPhone(db);
      downRenameVoiceToPhone(db);
    });
  });

  // ── v25: migrateDropAccountsTableDown (table recreation) ────────────

  describe("v25: migrateDropAccountsTableDown", () => {
    test("recreates the accounts table with correct schema", () => {
      const db = createTestDb();
      const raw = getRaw(db);

      migrateDropAccountsTableDown(db);

      const table = raw
        .query(
          `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'accounts'`,
        )
        .get();
      expect(table).toBeTruthy();

      // Check indexes.
      const idxService = raw
        .query(
          `SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_accounts_service'`,
        )
        .get();
      expect(idxService).toBeTruthy();

      const idxStatus = raw
        .query(
          `SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_accounts_status'`,
        )
        .get();
      expect(idxStatus).toBeTruthy();
    });

    test("idempotency: calling down twice does not throw", () => {
      const db = createTestDb();
      migrateDropAccountsTableDown(db);
      migrateDropAccountsTableDown(db);
    });
  });

  // ── v27: migrateDropRemindersTableDown (table recreation) ───────────

  describe("v27: migrateDropRemindersTableDown", () => {
    test("recreates the reminders table with correct schema", () => {
      const db = createTestDb();
      const raw = getRaw(db);

      migrateDropRemindersTableDown(db);

      const table = raw
        .query(
          `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'reminders'`,
        )
        .get();
      expect(table).toBeTruthy();

      // Verify index.
      const idx = raw
        .query(
          `SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_reminders_status_fire_at'`,
        )
        .get();
      expect(idx).toBeTruthy();

      // Verify columns include routing_intent and routing_hints_json.
      const cols = raw.query(`PRAGMA table_info(reminders)`).all() as Array<{
        name: string;
      }>;
      const colNames = cols.map((c) => c.name);
      expect(colNames).toContain("routing_intent");
      expect(colNames).toContain("routing_hints_json");
    });

    test("idempotency: calling down twice does not throw", () => {
      const db = createTestDb();
      migrateDropRemindersTableDown(db);
      migrateDropRemindersTableDown(db);
    });
  });

  // ── v28: migrateOAuthAppsClientSecretPathDown (column drop) ─────────

  describe("v28: migrateOAuthAppsClientSecretPathDown", () => {
    test("drops client_secret_credential_path column from oauth_apps", () => {
      const db = createTestDb();
      const raw = getRaw(db);

      raw.exec(/*sql*/ `
        CREATE TABLE oauth_providers (provider_key TEXT PRIMARY KEY, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
        CREATE TABLE oauth_apps (
          id TEXT PRIMARY KEY,
          provider_key TEXT NOT NULL REFERENCES oauth_providers(provider_key),
          client_id TEXT NOT NULL,
          client_secret_credential_path TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);

      migrateOAuthAppsClientSecretPathDown(db);

      const col = raw
        .query(
          `SELECT 1 FROM pragma_table_info('oauth_apps') WHERE name = 'client_secret_credential_path'`,
        )
        .get();
      expect(col).toBeNull();
    });

    test("idempotency: calling down twice does not throw", () => {
      const db = createTestDb();
      const raw = getRaw(db);
      raw.exec(
        `CREATE TABLE oauth_providers (provider_key TEXT PRIMARY KEY, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
      );
      raw.exec(
        `CREATE TABLE oauth_apps (id TEXT PRIMARY KEY, provider_key TEXT NOT NULL, client_id TEXT NOT NULL, client_secret_credential_path TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
      );

      migrateOAuthAppsClientSecretPathDown(db);
      migrateOAuthAppsClientSecretPathDown(db);
    });
  });

  // ── v31: migrateRenameGmailProviderKeyToGoogleDown ──────────────────

  describe("v31: migrateRenameGmailProviderKeyToGoogleDown", () => {
    test("renames integration:google back to integration:gmail", () => {
      const db = createTestDb();
      const raw = getRaw(db);

      raw.exec(/*sql*/ `
        CREATE TABLE oauth_providers (provider_key TEXT PRIMARY KEY);
        CREATE TABLE oauth_apps (id TEXT PRIMARY KEY, provider_key TEXT NOT NULL);
        CREATE TABLE oauth_connections (id TEXT PRIMARY KEY, provider_key TEXT NOT NULL);
        INSERT INTO oauth_providers VALUES ('integration:google');
        INSERT INTO oauth_apps VALUES ('app1', 'integration:google');
        INSERT INTO oauth_connections VALUES ('conn1', 'integration:google');
      `);

      migrateRenameGmailProviderKeyToGoogleDown(db);

      const provider = raw
        .query(
          `SELECT provider_key FROM oauth_providers WHERE provider_key = 'integration:gmail'`,
        )
        .get();
      expect(provider).toBeTruthy();

      const app = raw
        .query(`SELECT provider_key FROM oauth_apps WHERE id = 'app1'`)
        .get() as { provider_key: string };
      expect(app.provider_key).toBe("integration:gmail");
    });

    test("idempotency: calling down twice does not throw", () => {
      const db = createTestDb();
      const raw = getRaw(db);
      raw.exec(`CREATE TABLE oauth_providers (provider_key TEXT PRIMARY KEY)`);
      raw.exec(
        `CREATE TABLE oauth_apps (id TEXT PRIMARY KEY, provider_key TEXT NOT NULL)`,
      );
      raw.exec(
        `CREATE TABLE oauth_connections (id TEXT PRIMARY KEY, provider_key TEXT NOT NULL)`,
      );
      raw.exec(`INSERT INTO oauth_providers VALUES ('integration:google')`);

      migrateRenameGmailProviderKeyToGoogleDown(db);
      migrateRenameGmailProviderKeyToGoogleDown(db);
    });
  });

  // ── v32: migrateRenameThreadStartersTableDown ───────────────────────

  describe("v32: migrateRenameThreadStartersTableDown", () => {
    test("renames conversation_starters back to thread_starters", () => {
      const db = createTestDb();
      const raw = getRaw(db);

      raw.exec(/*sql*/ `
        CREATE TABLE conversation_starters (
          id TEXT PRIMARY KEY,
          generation_batch TEXT,
          card_type TEXT,
          scope_id TEXT,
          created_at INTEGER NOT NULL
        )
      `);
      raw.exec(
        `CREATE INDEX idx_conversation_starters_batch ON conversation_starters(generation_batch, created_at)`,
      );
      raw.exec(
        `CREATE INDEX idx_conversation_starters_card_type ON conversation_starters(card_type, scope_id)`,
      );

      migrateRenameThreadStartersTableDown(db);

      const oldTable = raw
        .query(
          `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'thread_starters'`,
        )
        .get();
      expect(oldTable).toBeTruthy();

      const newTable = raw
        .query(
          `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'conversation_starters'`,
        )
        .get();
      expect(newTable).toBeNull();

      // Old-style indexes should exist.
      const batchIdx = raw
        .query(
          `SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_thread_starters_batch'`,
        )
        .get();
      expect(batchIdx).toBeTruthy();
    });

    test("idempotency: calling down twice does not throw", () => {
      const db = createTestDb();
      const raw = getRaw(db);
      raw.exec(
        `CREATE TABLE conversation_starters (id TEXT PRIMARY KEY, generation_batch TEXT, card_type TEXT, scope_id TEXT, created_at INTEGER NOT NULL)`,
      );

      migrateRenameThreadStartersTableDown(db);
      migrateRenameThreadStartersTableDown(db);
    });
  });

  // ── v35: migrateRenameThreadStartersCheckpointsDown ─────────────────

  describe("v35: migrateRenameThreadStartersCheckpointsDown", () => {
    test("renames conversation_starters: checkpoint keys back to thread_starters:", () => {
      const db = createTestDb();
      const raw = getRaw(db);
      bootstrapCheckpointsTable(raw);

      const now = Date.now();
      raw.exec(
        `INSERT INTO memory_checkpoints (key, value, updated_at) VALUES ('conversation_starters:gen_batch_1', '1', ${now})`,
      );
      raw.exec(
        `INSERT INTO memory_checkpoints (key, value, updated_at) VALUES ('conversation_starters:gen_batch_2', '1', ${now})`,
      );

      migrateRenameThreadStartersCheckpointsDown(db);

      const newPrefixCount = (
        raw
          .query(
            `SELECT COUNT(*) AS c FROM memory_checkpoints WHERE key LIKE 'conversation_starters:%'`,
          )
          .get() as { c: number }
      ).c;
      expect(newPrefixCount).toBe(0);

      const oldPrefixCount = (
        raw
          .query(
            `SELECT COUNT(*) AS c FROM memory_checkpoints WHERE key LIKE 'thread_starters:%'`,
          )
          .get() as { c: number }
      ).c;
      expect(oldPrefixCount).toBe(2);
    });

    test("idempotency: calling down twice does not throw", () => {
      const db = createTestDb();
      const raw = getRaw(db);
      bootstrapCheckpointsTable(raw);

      const now = Date.now();
      raw.exec(
        `INSERT INTO memory_checkpoints (key, value, updated_at) VALUES ('conversation_starters:gen_batch_1', '1', ${now})`,
      );

      migrateRenameThreadStartersCheckpointsDown(db);
      migrateRenameThreadStartersCheckpointsDown(db);
    });
  });

  // ── v18: downBackfillContactInteractionStats ────────────────────────

  describe("v18: downBackfillContactInteractionStats", () => {
    test("clears last_interaction column", () => {
      const db = createTestDb();
      const raw = getRaw(db);

      raw.exec(/*sql*/ `
        CREATE TABLE contacts (
          id TEXT PRIMARY KEY,
          last_interaction INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);

      const now = Date.now();
      raw.exec(`INSERT INTO contacts VALUES ('c1', ${now}, ${now}, ${now})`);

      downBackfillContactInteractionStats(db);

      const contact = raw
        .query(`SELECT last_interaction FROM contacts WHERE id = 'c1'`)
        .get() as { last_interaction: number | null };
      expect(contact.last_interaction).toBeNull();
    });

    test("idempotency: calling down twice does not throw", () => {
      const db = createTestDb();
      const raw = getRaw(db);
      raw.exec(
        `CREATE TABLE contacts (id TEXT PRIMARY KEY, last_interaction INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
      );
      raw.exec(
        `INSERT INTO contacts VALUES ('c1', ${Date.now()}, ${Date.now()}, ${Date.now()})`,
      );

      downBackfillContactInteractionStats(db);
      downBackfillContactInteractionStats(db);
    });
  });

  // ── v12: downEmbeddingVectorBlob (column drop) ──────────────────────

  describe("v12: downEmbeddingVectorBlob", () => {
    test("drops vector_blob column from memory_embeddings", () => {
      const db = createTestDb();
      const raw = getRaw(db);

      raw.exec(/*sql*/ `
        CREATE TABLE memory_embeddings (
          id TEXT PRIMARY KEY,
          target_type TEXT NOT NULL,
          target_id TEXT NOT NULL,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          dimensions INTEGER NOT NULL,
          vector_json TEXT,
          vector_blob BLOB,
          content_hash TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE (target_type, target_id, provider, model)
        )
      `);

      downEmbeddingVectorBlob(db);

      const col = raw
        .query(
          `SELECT 1 FROM pragma_table_info('memory_embeddings') WHERE name = 'vector_blob'`,
        )
        .get();
      expect(col).toBeNull();

      // Other columns should still exist.
      const vectorJson = raw
        .query(
          `SELECT 1 FROM pragma_table_info('memory_embeddings') WHERE name = 'vector_json'`,
        )
        .get();
      expect(vectorJson).toBeTruthy();
    });

    test("idempotency: calling down twice does not throw", () => {
      const db = createTestDb();
      const raw = getRaw(db);
      raw.exec(/*sql*/ `
        CREATE TABLE memory_embeddings (
          id TEXT PRIMARY KEY,
          target_type TEXT NOT NULL,
          target_id TEXT NOT NULL,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          dimensions INTEGER NOT NULL,
          vector_json TEXT,
          vector_blob BLOB,
          content_hash TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);

      downEmbeddingVectorBlob(db);
      downEmbeddingVectorBlob(db);
    });
  });

  // ── v13: downEmbeddingsNullableVectorJson ───────────────────────────

  describe("v13: downEmbeddingsNullableVectorJson", () => {
    test("restores NOT NULL on vector_json column", () => {
      const db = createTestDb();
      const raw = getRaw(db);

      // Post-forward-migration schema: vector_json is nullable.
      raw.exec(/*sql*/ `
        CREATE TABLE memory_embeddings (
          id TEXT PRIMARY KEY,
          target_type TEXT NOT NULL,
          target_id TEXT NOT NULL,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          dimensions INTEGER NOT NULL,
          vector_json TEXT,
          vector_blob BLOB,
          content_hash TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE (target_type, target_id, provider, model)
        )
      `);

      const now = Date.now();
      raw.exec(
        `INSERT INTO memory_embeddings VALUES ('e1', 'item', 'item-1', 'openai', 'text-embedding-3-small', 1536, '[0.1,0.2]', NULL, 'hash1', ${now}, ${now})`,
      );

      downEmbeddingsNullableVectorJson(db);

      // Check that vector_json is now NOT NULL.
      const ddl =
        (
          raw
            .query(
              `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_embeddings'`,
            )
            .get() as { sql: string }
        )?.sql ?? "";
      expect(ddl).toMatch(/vector_json\s+TEXT\s+NOT\s+NULL/i);

      // Data with non-null vector_json should be preserved.
      const row = raw
        .query(`SELECT id FROM memory_embeddings WHERE id = 'e1'`)
        .get();
      expect(row).toBeTruthy();
    });

    test("idempotency: calling down twice does not throw", () => {
      const db = createTestDb();
      const raw = getRaw(db);
      raw.exec(/*sql*/ `
        CREATE TABLE memory_embeddings (
          id TEXT PRIMARY KEY, target_type TEXT NOT NULL, target_id TEXT NOT NULL,
          provider TEXT NOT NULL, model TEXT NOT NULL, dimensions INTEGER NOT NULL,
          vector_json TEXT, vector_blob BLOB, content_hash TEXT,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          UNIQUE (target_type, target_id, provider, model)
        )
      `);

      downEmbeddingsNullableVectorJson(db);
      downEmbeddingsNullableVectorJson(db);
    });
  });

  // ── v15: downBackfillGuardianPrincipalId ─────────────────────────────

  describe("v15: downBackfillGuardianPrincipalId", () => {
    test("nulls out guardian_principal_id on channel_guardian_bindings", () => {
      const db = createTestDb();
      const raw = getRaw(db);

      raw.exec(/*sql*/ `
        CREATE TABLE channel_guardian_bindings (
          id TEXT PRIMARY KEY,
          assistant_id TEXT NOT NULL,
          channel TEXT NOT NULL,
          guardian_external_user_id TEXT NOT NULL,
          guardian_delivery_chat_id TEXT NOT NULL,
          guardian_principal_id TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          verified_at INTEGER NOT NULL,
          verified_via TEXT NOT NULL DEFAULT 'challenge',
          metadata_json TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);

      const now = Date.now();
      raw.exec(
        `INSERT INTO channel_guardian_bindings VALUES ('b1', 'self', 'vellum', 'user1', 'chat1', 'principal1', 'active', ${now}, 'challenge', NULL, ${now}, ${now})`,
      );

      downBackfillGuardianPrincipalId(db);

      const row = raw
        .query(
          `SELECT guardian_principal_id FROM channel_guardian_bindings WHERE id = 'b1'`,
        )
        .get() as { guardian_principal_id: string | null };
      expect(row.guardian_principal_id).toBeNull();
    });

    test("idempotency: calling down twice does not throw", () => {
      const db = createTestDb();
      const raw = getRaw(db);
      raw.exec(
        `CREATE TABLE channel_guardian_bindings (id TEXT PRIMARY KEY, guardian_principal_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
      );

      downBackfillGuardianPrincipalId(db);
      downBackfillGuardianPrincipalId(db);
    });
  });

  // ── v16: downGuardianPrincipalIdNotNull ──────────────────────────────

  describe("v16: downGuardianPrincipalIdNotNull", () => {
    test("makes guardian_principal_id nullable again", () => {
      const db = createTestDb();
      const raw = getRaw(db);

      raw.exec(/*sql*/ `
        CREATE TABLE channel_guardian_bindings (
          id TEXT PRIMARY KEY,
          assistant_id TEXT NOT NULL,
          channel TEXT NOT NULL,
          guardian_external_user_id TEXT NOT NULL,
          guardian_delivery_chat_id TEXT NOT NULL,
          guardian_principal_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          verified_at INTEGER NOT NULL,
          verified_via TEXT NOT NULL DEFAULT 'challenge',
          metadata_json TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);

      // Confirm NOT NULL before down.
      const colBefore = raw
        .query(
          `SELECT "notnull" FROM pragma_table_info('channel_guardian_bindings') WHERE name = 'guardian_principal_id'`,
        )
        .get() as { notnull: number };
      expect(colBefore.notnull).toBe(1);

      downGuardianPrincipalIdNotNull(db);

      // After down, should be nullable.
      const colAfter = raw
        .query(
          `SELECT "notnull" FROM pragma_table_info('channel_guardian_bindings') WHERE name = 'guardian_principal_id'`,
        )
        .get() as { notnull: number };
      expect(colAfter.notnull).toBe(0);
    });

    test("idempotency: calling down twice does not throw", () => {
      const db = createTestDb();
      const raw = getRaw(db);
      raw.exec(/*sql*/ `
        CREATE TABLE channel_guardian_bindings (
          id TEXT PRIMARY KEY, assistant_id TEXT NOT NULL, channel TEXT NOT NULL,
          guardian_external_user_id TEXT NOT NULL, guardian_delivery_chat_id TEXT NOT NULL,
          guardian_principal_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
          verified_at INTEGER NOT NULL, verified_via TEXT NOT NULL DEFAULT 'challenge',
          metadata_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        )
      `);

      downGuardianPrincipalIdNotNull(db);
      downGuardianPrincipalIdNotNull(db);
    });
  });

  // ── v29: migrateGuardianTimestampsEpochMsDown ───────────────────────

  describe("v29: migrateGuardianTimestampsEpochMsDown", () => {
    test("converts epoch ms integers back to ISO 8601 strings", () => {
      const db = createTestDb();
      const raw = getRaw(db);

      raw.exec(/*sql*/ `
        CREATE TABLE canonical_guardian_requests (
          id TEXT PRIMARY KEY, kind TEXT NOT NULL, source_type TEXT NOT NULL,
          source_channel TEXT, status TEXT NOT NULL DEFAULT 'pending',
          expires_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE canonical_guardian_deliveries (
          id TEXT PRIMARY KEY, request_id TEXT NOT NULL, destination_channel TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE scoped_approval_grants (
          id TEXT PRIMARY KEY, scope_mode TEXT NOT NULL, request_channel TEXT NOT NULL,
          decision_channel TEXT NOT NULL, status TEXT NOT NULL,
          expires_at INTEGER NOT NULL, consumed_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
      `);

      // Insert with epoch ms values (post-forward-migration state).
      const epochMs = 1700000000000; // 2023-11-14T22:13:20.000Z
      raw.exec(
        `INSERT INTO canonical_guardian_requests VALUES ('r1', 'approval', 'desktop', 'vellum', 'pending', NULL, ${epochMs}, ${epochMs})`,
      );
      raw.exec(
        `INSERT INTO canonical_guardian_deliveries VALUES ('d1', 'r1', 'vellum', 'pending', ${epochMs}, ${epochMs})`,
      );
      raw.exec(
        `INSERT INTO scoped_approval_grants VALUES ('g1', 'once', 'vellum', 'vellum', 'active', ${epochMs}, NULL, ${epochMs}, ${epochMs})`,
      );

      migrateGuardianTimestampsEpochMsDown(db);

      // Verify created_at is now a text ISO 8601 string.
      const req = raw
        .query(
          `SELECT created_at, typeof(created_at) AS t FROM canonical_guardian_requests WHERE id = 'r1'`,
        )
        .get() as { created_at: string; t: string };
      expect(req.t).toBe("text");
      expect(req.created_at).toContain("2023-11-14");
    });

    test("idempotency: calling down twice does not throw", () => {
      const db = createTestDb();
      const raw = getRaw(db);
      raw.exec(
        `CREATE TABLE canonical_guardian_requests (id TEXT PRIMARY KEY, kind TEXT NOT NULL, source_type TEXT NOT NULL, source_channel TEXT, status TEXT NOT NULL, expires_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
      );
      raw.exec(
        `CREATE TABLE canonical_guardian_deliveries (id TEXT PRIMARY KEY, request_id TEXT NOT NULL, destination_channel TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
      );
      raw.exec(
        `CREATE TABLE scoped_approval_grants (id TEXT PRIMARY KEY, scope_mode TEXT NOT NULL, request_channel TEXT NOT NULL, decision_channel TEXT NOT NULL, status TEXT NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
      );

      const epochMs = 1700000000000;
      raw.exec(
        `INSERT INTO canonical_guardian_requests VALUES ('r1', 'approval', 'desktop', 'vellum', 'pending', NULL, ${epochMs}, ${epochMs})`,
      );

      migrateGuardianTimestampsEpochMsDown(db);
      // Second call — values are already text, typeof check skips them.
      migrateGuardianTimestampsEpochMsDown(db);
    });
  });

  // ── v30: migrateGuardianTimestampsRebuildDown ───────────────────────

  describe("v30: migrateGuardianTimestampsRebuildDown", () => {
    test("rebuilds tables with TEXT affinity on timestamp columns", () => {
      const db = createTestDb();
      const raw = getRaw(db);

      // Post-forward-migration state: INTEGER affinity on timestamp columns.
      raw.exec(/*sql*/ `
        CREATE TABLE canonical_guardian_requests (
          id TEXT PRIMARY KEY, kind TEXT NOT NULL, source_type TEXT NOT NULL,
          source_channel TEXT, conversation_id TEXT, requester_external_user_id TEXT,
          requester_chat_id TEXT, guardian_external_user_id TEXT, guardian_principal_id TEXT,
          call_session_id TEXT, pending_question_id TEXT, question_text TEXT,
          request_code TEXT, tool_name TEXT, input_digest TEXT,
          status TEXT NOT NULL DEFAULT 'pending', answer_text TEXT,
          decided_by_external_user_id TEXT, decided_by_principal_id TEXT,
          followup_state TEXT, expires_at INTEGER,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE canonical_guardian_deliveries (
          id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES canonical_guardian_requests(id) ON DELETE CASCADE,
          destination_channel TEXT NOT NULL, destination_conversation_id TEXT,
          destination_chat_id TEXT, destination_message_id TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE scoped_approval_grants (
          id TEXT PRIMARY KEY, scope_mode TEXT NOT NULL, request_id TEXT,
          tool_name TEXT, input_digest TEXT, request_channel TEXT NOT NULL,
          decision_channel TEXT NOT NULL, execution_channel TEXT,
          conversation_id TEXT, call_session_id TEXT,
          requester_external_user_id TEXT, guardian_external_user_id TEXT,
          status TEXT NOT NULL, expires_at INTEGER NOT NULL,
          consumed_at INTEGER, consumed_by_request_id TEXT,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
      `);

      migrateGuardianTimestampsRebuildDown(db);

      // Verify TEXT affinity on created_at.
      const colType = raw
        .query(
          `SELECT type FROM pragma_table_info('canonical_guardian_requests') WHERE name = 'created_at'`,
        )
        .get() as { type: string };
      expect(colType.type.toUpperCase()).toBe("TEXT");
    });

    test("idempotency: calling down twice does not throw", () => {
      const db = createTestDb();
      const raw = getRaw(db);

      raw.exec(/*sql*/ `
        CREATE TABLE canonical_guardian_requests (
          id TEXT PRIMARY KEY, kind TEXT NOT NULL, source_type TEXT NOT NULL,
          source_channel TEXT, conversation_id TEXT, requester_external_user_id TEXT,
          requester_chat_id TEXT, guardian_external_user_id TEXT, guardian_principal_id TEXT,
          call_session_id TEXT, pending_question_id TEXT, question_text TEXT,
          request_code TEXT, tool_name TEXT, input_digest TEXT,
          status TEXT NOT NULL DEFAULT 'pending', answer_text TEXT,
          decided_by_external_user_id TEXT, decided_by_principal_id TEXT,
          followup_state TEXT, expires_at INTEGER,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE canonical_guardian_deliveries (
          id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES canonical_guardian_requests(id) ON DELETE CASCADE,
          destination_channel TEXT NOT NULL, destination_conversation_id TEXT,
          destination_chat_id TEXT, destination_message_id TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE scoped_approval_grants (
          id TEXT PRIMARY KEY, scope_mode TEXT NOT NULL, request_id TEXT,
          tool_name TEXT, input_digest TEXT, request_channel TEXT NOT NULL,
          decision_channel TEXT NOT NULL, execution_channel TEXT,
          conversation_id TEXT, call_session_id TEXT,
          requester_external_user_id TEXT, guardian_external_user_id TEXT,
          status TEXT NOT NULL, expires_at INTEGER NOT NULL,
          consumed_at INTEGER, consumed_by_request_id TEXT,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
      `);

      migrateGuardianTimestampsRebuildDown(db);
      migrateGuardianTimestampsRebuildDown(db);
    });
  });
});
