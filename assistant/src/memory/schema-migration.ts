import { computeMemoryFingerprint } from './fingerprint.js';
import { getSqliteFrom, type DrizzleDb } from './db-connection.js';
import { getLogger } from '../util/logger.js';

const log = getLogger('memory-db');

type Db = DrizzleDb;

// ---------------------------------------------------------------------------
// Migration registry
// ---------------------------------------------------------------------------
// Central registry of all checkpoint-based one-shot migrations.  Each entry
// carries a monotonic version number (for documentation / ordering assertions)
// and an optional list of prerequisite checkpoint keys that must already be
// completed before this migration runs.
//
// Migrations that use pure DDL guards (CREATE TABLE IF NOT EXISTS, index
// presence checks, ALTER TABLE ADD COLUMN try/catch) are inherently idempotent
// and do not need entries here — they are safe to re-run on every startup.
// ---------------------------------------------------------------------------

export interface MigrationRegistryEntry {
  /** The checkpoint key written to memory_checkpoints on completion. */
  key: string;
  /** Monotonic version number used for ordering assertions. */
  version: number;
  /** Keys of other migrations that must complete before this one runs. */
  dependsOn?: string[];
  /** Human-readable description for diagnostics and future authorship guidance. */
  description: string;
}

export const MIGRATION_REGISTRY: MigrationRegistryEntry[] = [
  {
    key: 'migration_job_deferrals',
    version: 1,
    description: 'Reconcile legacy deferral history from attempts column into deferrals column',
  },
  {
    key: 'migration_memory_entity_relations_dedup_v1',
    version: 2,
    description: 'Deduplicate entity relation edges before enforcing the (source, target, relation) unique index',
  },
  {
    key: 'migration_memory_items_fingerprint_scope_unique_v1',
    version: 3,
    description: 'Replace column-level UNIQUE on fingerprint with compound (fingerprint, scope_id) unique index',
  },
  {
    key: 'migration_memory_items_scope_salted_fingerprints_v1',
    version: 4,
    dependsOn: ['migration_memory_items_fingerprint_scope_unique_v1'],
    description: 'Recompute memory item fingerprints to include scope_id prefix after schema change',
  },
  {
    key: 'migration_normalize_assistant_id_to_self_v1',
    version: 5,
    description: 'Normalize all assistant_id values in scoped tables to the implicit "self" single-tenant identity',
  },
  {
    key: 'migration_remove_assistant_id_columns_v1',
    version: 6,
    dependsOn: ['migration_normalize_assistant_id_to_self_v1'],
    description: 'Rebuild four tables to drop the assistant_id column after normalization',
  },
  {
    key: 'migration_remove_assistant_id_lue_v1',
    version: 7,
    dependsOn: ['migration_normalize_assistant_id_to_self_v1'],
    description: 'Remove assistant_id column from llm_usage_events (separate checkpoint from the four-table migration)',
  },
];

/**
 * Validate the applied migration state against the registry at startup.
 *
 * Logs warnings when a migration started but never completed (crash detected),
 * and logs errors when a migration was applied but a declared prerequisite is
 * missing from the checkpoints table (dependency ordering violation).
 *
 * Call this AFTER all DDL and migration functions have run so that the final
 * state is inspected.
 */
export function validateMigrationState(database: Db): void {
  const raw = getSqliteFrom(database);

  let rows: Array<{ key: string; value: string }>;
  try {
    rows = raw.query(`SELECT key, value FROM memory_checkpoints`).all() as Array<{ key: string; value: string }>;
  } catch {
    // memory_checkpoints may not exist on a very old database; skip.
    return;
  }

  const applied = new Map(rows.map((r) => [r.key, r.value]));

  // Detect crashed migrations: a checkpoint value of 'started' means the
  // migration wrote its start marker but never reached the completion INSERT.
  // The migration will re-run on the next startup (its own idempotency guard
  // will determine safety), but we surface a warning for visibility.
  const crashed = rows.filter((r) => r.value === 'started').map((r) => r.key);
  if (crashed.length > 0) {
    log.warn(
      { crashed },
      'Crashed migrations detected — these migrations started but never completed; they will re-run on next startup',
    );
  }

  // Validate dependency ordering.
  for (const entry of MIGRATION_REGISTRY) {
    if (!entry.dependsOn || entry.dependsOn.length === 0) continue;
    // Only check entries that have been applied — unapplied migrations have
    // not had a chance to violate their prerequisites yet.
    if (!applied.has(entry.key)) continue;

    for (const dep of entry.dependsOn) {
      if (!applied.has(dep)) {
        log.error(
          { migration: entry.key, missingDependency: dep, version: entry.version },
          'Migration dependency violation: this migration is marked complete but its declared prerequisite has no checkpoint — database schema may be inconsistent',
        );
      }
    }
  }
}

/**
 * One-shot migration: reconcile old deferral history into the new `deferrals` column.
 *
 * Before the `deferrals` column was added, `deferMemoryJob` incremented `attempts`.
 * After the column is added with DEFAULT 0, those legacy jobs still carry the old
 * attempt count (which was really a deferral count) while `deferrals` is 0. This
 * moves the attempt count into `deferrals` and resets `attempts` to 0.
 *
 * This migration MUST run only once. On subsequent startups, post-migration jobs
 * that genuinely failed via `failMemoryJob` (attempts > 0, deferrals = 0, non-null
 * last_error) must NOT be touched — resetting their attempts would let them bypass
 * the configured maxAttempts budget across restarts.
 *
 * We use a `memory_checkpoints` row to ensure the migration runs exactly once.
 */
export function migrateJobDeferrals(database: Db): void {
  const raw = getSqliteFrom(database);
  const checkpoint = raw.query(
    `SELECT 1 FROM memory_checkpoints WHERE key = 'migration_job_deferrals'`
  ).get();
  if (checkpoint) return;

  try {
    raw.exec(/*sql*/ `
      BEGIN;
      UPDATE memory_jobs
      SET deferrals = attempts,
          attempts = 0,
          last_error = NULL,
          updated_at = ${Date.now()}
      WHERE status = 'pending'
        AND attempts > 0
        AND deferrals = 0
        AND type IN ('embed_segment', 'embed_item', 'embed_summary');
      INSERT OR IGNORE INTO memory_checkpoints (key, value, updated_at)
      VALUES ('migration_job_deferrals', '1', ${Date.now()});
      COMMIT;
    `);
  } catch (e) {
    try { raw.exec('ROLLBACK'); } catch { /* no active transaction */ }
    throw e;
  }
}

/**
 * Migrate existing tool_invocations table to add FK constraint with ON DELETE CASCADE.
 * SQLite doesn't support ALTER TABLE ADD CONSTRAINT, so we rebuild the table.
 * This is idempotent: it checks whether the FK already exists before migrating.
 */
export function migrateToolInvocationsFk(database: Db): void {
  const raw = getSqliteFrom(database);
  const row = raw.query(`SELECT sql FROM sqlite_master WHERE type='table' AND name='tool_invocations'`).get() as { sql: string } | null;
  if (!row) return; // table doesn't exist yet (will be created above)

  // If the DDL already contains REFERENCES, the FK is in place
  if (row.sql.includes('REFERENCES')) return;

  raw.exec('PRAGMA foreign_keys = OFF');
  try {
    raw.exec(/*sql*/ `
      BEGIN;
      CREATE TABLE tool_invocations_new (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        tool_name TEXT NOT NULL,
        input TEXT NOT NULL,
        result TEXT NOT NULL,
        decision TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      INSERT INTO tool_invocations_new SELECT t.* FROM tool_invocations t
        WHERE EXISTS (SELECT 1 FROM conversations c WHERE c.id = t.conversation_id);
      DROP TABLE tool_invocations;
      ALTER TABLE tool_invocations_new RENAME TO tool_invocations;
      COMMIT;
    `);
  } catch (e) {
    try { raw.exec('ROLLBACK'); } catch { /* no active transaction */ }
    throw e;
  } finally {
    raw.exec('PRAGMA foreign_keys = ON');
  }
}

/**
 * Backfill FTS rows for existing memory_segments records when upgrading from a
 * version that may not have had trigger-managed FTS.
 */
export function migrateMemoryFtsBackfill(database: Db): void {
  const raw = getSqliteFrom(database);
  const ftsCountRow = raw.query(`SELECT COUNT(*) AS c FROM memory_segment_fts`).get() as { c: number } | null;
  const ftsCount = ftsCountRow?.c ?? 0;
  if (ftsCount > 0) return;

  raw.exec(/*sql*/ `
    INSERT INTO memory_segment_fts(segment_id, text)
    SELECT id, text FROM memory_segments
  `);
}

/**
 * One-shot migration: merge duplicate relation edges so uniqueness can be
 * enforced on (source_entity_id, target_entity_id, relation).
 */
export function migrateMemoryEntityRelationDedup(database: Db): void {
  const raw = getSqliteFrom(database);
  const checkpointKey = 'migration_memory_entity_relations_dedup_v1';
  const checkpoint = raw.query(
    `SELECT 1 FROM memory_checkpoints WHERE key = ?`,
  ).get(checkpointKey);
  if (checkpoint) return;

  try {
    raw.exec('BEGIN');

    raw.exec(/*sql*/ `
      CREATE TEMP TABLE memory_entity_relation_merge AS
      WITH ranked AS (
        SELECT
          source_entity_id,
          target_entity_id,
          relation,
          first_seen_at,
          last_seen_at,
          evidence,
          ROW_NUMBER() OVER (
            PARTITION BY source_entity_id, target_entity_id, relation
            ORDER BY last_seen_at DESC, first_seen_at DESC, id DESC
          ) AS rank_latest
        FROM memory_entity_relations
      )
      SELECT
        source_entity_id,
        target_entity_id,
        relation,
        MIN(first_seen_at) AS merged_first_seen_at,
        MAX(last_seen_at) AS merged_last_seen_at,
        MAX(CASE WHEN rank_latest = 1 THEN evidence ELSE NULL END) AS merged_evidence
      FROM ranked
      GROUP BY source_entity_id, target_entity_id, relation
    `);

    raw.exec(/*sql*/ `DELETE FROM memory_entity_relations`);

    raw.exec(/*sql*/ `
      INSERT INTO memory_entity_relations (
        id,
        source_entity_id,
        target_entity_id,
        relation,
        evidence,
        first_seen_at,
        last_seen_at
      )
      SELECT
        lower(hex(randomblob(16))),
        source_entity_id,
        target_entity_id,
        relation,
        merged_evidence,
        merged_first_seen_at,
        merged_last_seen_at
      FROM memory_entity_relation_merge
    `);

    raw.exec(/*sql*/ `DROP TABLE memory_entity_relation_merge`);

    raw.query(
      `INSERT OR IGNORE INTO memory_checkpoints (key, value, updated_at) VALUES (?, '1', ?)`,
    ).run(checkpointKey, Date.now());

    raw.exec('COMMIT');
  } catch (e) {
    try { raw.exec('ROLLBACK'); } catch { /* no active transaction */ }
    throw e;
  }
}

/**
 * Migrate from a column-level UNIQUE on fingerprint to a compound unique
 * index on (fingerprint, scope_id) so that the same item can exist in
 * different scopes independently.
 */
export function migrateMemoryItemsFingerprintScopeUnique(database: Db): void {
  const raw = getSqliteFrom(database);
  const checkpointKey = 'migration_memory_items_fingerprint_scope_unique_v1';
  const checkpoint = raw.query(
    `SELECT 1 FROM memory_checkpoints WHERE key = ?`,
  ).get(checkpointKey);
  if (checkpoint) return;

  // Check if the old column-level UNIQUE constraint still exists by inspecting
  // the CREATE TABLE DDL for the word UNIQUE (the PK also creates an autoindex,
  // so we cannot rely on sqlite_autoindex_* presence alone).
  const tableDdl = raw.query(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_items'`,
  ).get() as { sql: string } | null;
  if (!tableDdl || !tableDdl.sql.match(/fingerprint\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i)) {
    // No column-level UNIQUE on fingerprint — either fresh DB or already migrated.
    raw.query(
      `INSERT OR IGNORE INTO memory_checkpoints (key, value, updated_at) VALUES (?, '1', ?)`,
    ).run(checkpointKey, Date.now());
    return;
  }

  // Rebuild the table without the column-level UNIQUE constraint.
  raw.exec('PRAGMA foreign_keys = OFF');
  try {
    raw.exec('BEGIN');

    // Create new table without UNIQUE on fingerprint — all other columns
    // match the latest schema (including migration-added columns).
    raw.exec(/*sql*/ `
      CREATE TABLE memory_items_new (
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
        importance REAL,
        access_count INTEGER NOT NULL DEFAULT 0,
        valid_from INTEGER,
        invalid_at INTEGER,
        verification_state TEXT NOT NULL DEFAULT 'assistant_inferred',
        scope_id TEXT NOT NULL DEFAULT 'default'
      )
    `);

    raw.exec(/*sql*/ `
      INSERT INTO memory_items_new
      SELECT id, kind, subject, statement, status, confidence, fingerprint,
             first_seen_at, last_seen_at, last_used_at, importance, access_count,
             valid_from, invalid_at, verification_state, scope_id
      FROM memory_items
    `);

    raw.exec(/*sql*/ `DROP TABLE memory_items`);
    raw.exec(/*sql*/ `ALTER TABLE memory_items_new RENAME TO memory_items`);

    raw.query(
      `INSERT OR IGNORE INTO memory_checkpoints (key, value, updated_at) VALUES (?, '1', ?)`,
    ).run(checkpointKey, Date.now());

    raw.exec('COMMIT');
  } catch (e) {
    try { raw.exec('ROLLBACK'); } catch { /* no active transaction */ }
    throw e;
  } finally {
    raw.exec('PRAGMA foreign_keys = ON');
  }
}

/**
 * One-shot migration: recompute fingerprints for existing memory items to
 * include the scope_id prefix introduced in the scope-salted fingerprint PR.
 *
 * Old format: sha256(`${kind}|${subject.toLowerCase()}|${statement.toLowerCase()}`)
 * New format: sha256(`${scopeId}|${kind}|${subject.toLowerCase()}|${statement.toLowerCase()}`)
 *
 * Without this migration, pre-upgrade items would never match on re-extraction,
 * causing duplicates and broken deduplication.
 */
export function migrateMemoryItemsScopeSaltedFingerprints(database: Db): void {
  const raw = getSqliteFrom(database);
  const checkpointKey = 'migration_memory_items_scope_salted_fingerprints_v1';
  const checkpoint = raw.query(
    `SELECT 1 FROM memory_checkpoints WHERE key = ?`,
  ).get(checkpointKey);
  if (checkpoint) return;

  interface ItemRow {
    id: string;
    kind: string;
    subject: string;
    statement: string;
    scope_id: string;
  }

  const items = raw.query(
    `SELECT id, kind, subject, statement, scope_id FROM memory_items`,
  ).all() as ItemRow[];

  if (items.length === 0) {
    raw.query(
      `INSERT OR IGNORE INTO memory_checkpoints (key, value, updated_at) VALUES (?, '1', ?)`,
    ).run(checkpointKey, Date.now());
    return;
  }

  try {
    raw.exec('BEGIN');

    const updateStmt = raw.prepare(
      `UPDATE memory_items SET fingerprint = ? WHERE id = ?`,
    );

    for (const item of items) {
      const fingerprint = computeMemoryFingerprint(item.scope_id, item.kind, item.subject, item.statement);
      updateStmt.run(fingerprint, item.id);
    }

    raw.query(
      `INSERT OR IGNORE INTO memory_checkpoints (key, value, updated_at) VALUES (?, '1', ?)`,
    ).run(checkpointKey, Date.now());

    raw.exec('COMMIT');
  } catch (e) {
    try { raw.exec('ROLLBACK'); } catch { /* no active transaction */ }
    throw e;
  }
}

/**
 * One-shot migration: normalize all assistant_id values in assistant-scoped tables
 * to "self" so they are visible after the daemon switched to the implicit single-tenant
 * identity.
 *
 * Before this change, rows were keyed by the real assistantId string passed via the
 * HTTP route. After the route change, all lookups use the constant "self". Without this
 * migration an upgraded daemon would see empty history / attachment lists for existing
 * data that was stored under the old assistantId.
 *
 * Affected tables:
 *   - conversation_keys   UNIQUE (assistant_id, conversation_key)
 *   - attachments         UNIQUE (assistant_id, content_hash) WHERE content_hash IS NOT NULL
 *   - channel_inbound_events  UNIQUE (assistant_id, source_channel, external_chat_id, external_message_id)
 *   - message_runs        no unique constraint on assistant_id
 *
 * Data-safety guarantees:
 *   - conversation_keys: when a key exists under both 'self' and a real assistantId, the
 *     'self' row is updated to point to the real-assistantId conversation (which holds the
 *     historical message thread). The 'self' conversation may be orphaned but is not deleted.
 *   - attachments: message_attachments links are remapped to the surviving attachment before
 *     any duplicate row is deleted, so no message loses its attachment metadata.
 *   - channel_inbound_events: only delivery-tracking metadata, not user content; dedup
 *     keeps one row per unique (channel, chat, message) tuple.
 *   - All conversations and messages remain untouched — only assistant_id index columns
 *     and key-lookup rows are modified.
 */
export function migrateAssistantIdToSelf(database: Db): void {
  const raw = getSqliteFrom(database);
  const checkpointKey = 'migration_normalize_assistant_id_to_self_v1';
  const checkpoint = raw.query(
    `SELECT 1 FROM memory_checkpoints WHERE key = ?`,
  ).get(checkpointKey);
  if (checkpoint) return;

  // On fresh installs the tables are created without assistant_id (PR 7+). Skip the
  // migration if NONE of the four affected tables have the column — pre-seed the
  // checkpoint so subsequent startups are also skipped. Checking all four (not just
  // conversation_keys) avoids a false negative on very old installs where
  // conversation_keys may not exist yet but other tables still carry assistant_id data.
  const affectedTables = ['conversation_keys', 'attachments', 'channel_inbound_events', 'message_runs'];
  const anyHasAssistantId = affectedTables.some((tbl) => {
    const ddl = raw.query(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`,
    ).get(tbl) as { sql: string } | null;
    return ddl?.sql.includes('assistant_id') ?? false;
  });
  if (!anyHasAssistantId) {
    raw.query(
      `INSERT OR IGNORE INTO memory_checkpoints (key, value, updated_at) VALUES (?, '1', ?)`,
    ).run(checkpointKey, Date.now());
    return;
  }

  // Helper: returns true if the given table's current DDL contains 'assistant_id'.
  const tableHasAssistantId = (tbl: string): boolean => {
    const ddl = raw.query(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`,
    ).get(tbl) as { sql: string } | null;
    return ddl?.sql.includes('assistant_id') ?? false;
  };

  try {
    raw.exec('BEGIN');

    // Each section is guarded so that SQL referencing assistant_id is only executed
    // when the column still exists in that table. This handles mixed-schema states
    // (e.g., very old installs where some tables may already lack the column).

    // conversation_keys: UNIQUE (assistant_id, conversation_key)
    if (tableHasAssistantId('conversation_keys')) {
      // Step 1: Among non-self rows, keep only one per conversation_key so the
      //         bulk UPDATE cannot hit a (non-self-A, key) + (non-self-B, key) collision.
      raw.exec(/*sql*/ `
        DELETE FROM conversation_keys
        WHERE assistant_id != 'self'
          AND rowid NOT IN (
            SELECT MIN(rowid) FROM conversation_keys
            WHERE assistant_id != 'self'
            GROUP BY conversation_key
          )
      `);
      // Step 2: For 'self' rows that have a non-self counterpart with the same
      //         conversation_key, update the 'self' row to use the non-self row's
      //         conversation_id. This preserves the historical conversation (which
      //         has the message history from before the route change) rather than
      //         discarding it in favour of a potentially-empty 'self' conversation.
      raw.exec(/*sql*/ `
        UPDATE conversation_keys
        SET conversation_id = (
          SELECT ck_ns.conversation_id
          FROM conversation_keys ck_ns
          WHERE ck_ns.assistant_id != 'self'
            AND ck_ns.conversation_key = conversation_keys.conversation_key
          ORDER BY ck_ns.rowid
          LIMIT 1
        )
        WHERE assistant_id = 'self'
          AND EXISTS (
            SELECT 1 FROM conversation_keys ck_ns
            WHERE ck_ns.assistant_id != 'self'
              AND ck_ns.conversation_key = conversation_keys.conversation_key
          )
      `);
      // Step 3: Delete the now-redundant non-self rows (their conversation_ids
      //         have been preserved in the 'self' rows above).
      raw.exec(/*sql*/ `
        DELETE FROM conversation_keys
        WHERE assistant_id != 'self'
          AND EXISTS (
            SELECT 1 FROM conversation_keys ck2
            WHERE ck2.assistant_id = 'self'
              AND ck2.conversation_key = conversation_keys.conversation_key
          )
      `);
      // Step 4: Remaining non-self rows have no 'self' counterpart — safe to bulk-update.
      raw.exec(/*sql*/ `
        UPDATE conversation_keys SET assistant_id = 'self' WHERE assistant_id != 'self'
      `);
    }

    // attachments: UNIQUE (assistant_id, content_hash) WHERE content_hash IS NOT NULL
    //
    // message_attachments rows reference attachment IDs with ON DELETE CASCADE, so we
    // must remap links to the surviving row BEFORE deleting duplicates to avoid
    // silently dropping attachment metadata from messages.
    if (tableHasAssistantId('attachments')) {
      // Step 1: Remap message_attachments from non-self duplicates to their survivor
      //         (MIN rowid per content_hash group), then delete the duplicates.
      raw.exec(/*sql*/ `
        UPDATE message_attachments
        SET attachment_id = (
          SELECT a_survivor.id
          FROM attachments a_survivor
          WHERE a_survivor.assistant_id != 'self'
            AND a_survivor.content_hash = (
              SELECT a_dup.content_hash FROM attachments a_dup
              WHERE a_dup.id = message_attachments.attachment_id
            )
          ORDER BY a_survivor.rowid
          LIMIT 1
        )
        WHERE attachment_id IN (
          SELECT id FROM attachments
          WHERE assistant_id != 'self'
            AND content_hash IS NOT NULL
            AND rowid NOT IN (
              SELECT MIN(rowid) FROM attachments
              WHERE assistant_id != 'self' AND content_hash IS NOT NULL
              GROUP BY content_hash
            )
        )
      `);
      raw.exec(/*sql*/ `
        DELETE FROM attachments
        WHERE assistant_id != 'self'
          AND content_hash IS NOT NULL
          AND rowid NOT IN (
            SELECT MIN(rowid) FROM attachments
            WHERE assistant_id != 'self'
              AND content_hash IS NOT NULL
            GROUP BY content_hash
          )
      `);
      // Step 2: Remap message_attachments from non-self rows conflicting with a 'self'
      //         row to the 'self' row, then delete the now-unlinked non-self rows.
      raw.exec(/*sql*/ `
        UPDATE message_attachments
        SET attachment_id = (
          SELECT a_self.id
          FROM attachments a_self
          WHERE a_self.assistant_id = 'self'
            AND a_self.content_hash = (
              SELECT a_ns.content_hash FROM attachments a_ns
              WHERE a_ns.id = message_attachments.attachment_id
            )
          LIMIT 1
        )
        WHERE attachment_id IN (
          SELECT id FROM attachments
          WHERE assistant_id != 'self'
            AND content_hash IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM attachments a2
              WHERE a2.assistant_id = 'self'
                AND a2.content_hash = attachments.content_hash
            )
        )
      `);
      raw.exec(/*sql*/ `
        DELETE FROM attachments
        WHERE assistant_id != 'self'
          AND content_hash IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM attachments a2
            WHERE a2.assistant_id = 'self'
              AND a2.content_hash = attachments.content_hash
          )
      `);
      // Step 3: Bulk-update remaining non-self rows.
      raw.exec(/*sql*/ `
        UPDATE attachments SET assistant_id = 'self' WHERE assistant_id != 'self'
      `);
    }

    // channel_inbound_events: UNIQUE (assistant_id, source_channel, external_chat_id, external_message_id)
    if (tableHasAssistantId('channel_inbound_events')) {
      // Step 1: Dedup non-self rows sharing the same (source_channel, external_chat_id, external_message_id).
      raw.exec(/*sql*/ `
        DELETE FROM channel_inbound_events
        WHERE assistant_id != 'self'
          AND rowid NOT IN (
            SELECT MIN(rowid) FROM channel_inbound_events
            WHERE assistant_id != 'self'
            GROUP BY source_channel, external_chat_id, external_message_id
          )
      `);
      // Step 2: Delete non-self rows conflicting with existing 'self' rows.
      raw.exec(/*sql*/ `
        DELETE FROM channel_inbound_events
        WHERE assistant_id != 'self'
          AND EXISTS (
            SELECT 1 FROM channel_inbound_events e2
            WHERE e2.assistant_id = 'self'
              AND e2.source_channel = channel_inbound_events.source_channel
              AND e2.external_chat_id = channel_inbound_events.external_chat_id
              AND e2.external_message_id = channel_inbound_events.external_message_id
          )
      `);
      // Step 3: Bulk-update remaining non-self rows.
      raw.exec(/*sql*/ `
        UPDATE channel_inbound_events SET assistant_id = 'self' WHERE assistant_id != 'self'
      `);
    }

    // message_runs: no unique constraint on assistant_id — simple bulk update
    if (tableHasAssistantId('message_runs')) {
      raw.exec(/*sql*/ `
        UPDATE message_runs SET assistant_id = 'self' WHERE assistant_id != 'self'
      `);
    }

    raw.query(
      `INSERT OR IGNORE INTO memory_checkpoints (key, value, updated_at) VALUES (?, '1', ?)`,
    ).run(checkpointKey, Date.now());

    raw.exec('COMMIT');
  } catch (e) {
    try { raw.exec('ROLLBACK'); } catch { /* no active transaction */ }
    throw e;
  }
}

/**
 * One-shot migration: rebuild tables that previously stored assistant_id to remove
 * that column now that all rows are keyed to the implicit single-tenant identity ("self").
 *
 * Must run AFTER migrateAssistantIdToSelf (which normalises all values to "self")
 * so there are no constraint violations when recreating the tables without the
 * assistant_id dimension.
 *
 * Each table section is guarded by a DDL check so this is safe on fresh installs
 * where the column was never created in the first place.
 *
 * Tables rebuilt:
 *   - conversation_keys       UNIQUE (conversation_key)
 *   - attachments             no structural unique; content-dedup index updated
 *   - channel_inbound_events  UNIQUE (source_channel, external_chat_id, external_message_id)
 *   - message_runs            no unique constraint on assistant_id
 *   - llm_usage_events        nullable column with no constraint
 */
export function migrateRemoveAssistantIdColumns(database: Db): void {
  const raw = getSqliteFrom(database);
  const checkpointKey = 'migration_remove_assistant_id_columns_v1';
  const checkpoint = raw.query(
    `SELECT 1 FROM memory_checkpoints WHERE key = ?`,
  ).get(checkpointKey);
  if (checkpoint) return;

  raw.exec('PRAGMA foreign_keys = OFF');
  try {
    raw.exec('BEGIN');

    // --- conversation_keys ---
    const ckDdl = raw.query(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'conversation_keys'`,
    ).get() as { sql: string } | null;
    if (ckDdl?.sql.includes('assistant_id')) {
      raw.exec(/*sql*/ `
        CREATE TABLE conversation_keys_new (
          id TEXT PRIMARY KEY,
          conversation_key TEXT NOT NULL UNIQUE,
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          created_at INTEGER NOT NULL
        )
      `);
      raw.exec(/*sql*/ `
        INSERT INTO conversation_keys_new (id, conversation_key, conversation_id, created_at)
        SELECT id, conversation_key, conversation_id, created_at FROM conversation_keys
      `);
      raw.exec(/*sql*/ `DROP TABLE conversation_keys`);
      raw.exec(/*sql*/ `ALTER TABLE conversation_keys_new RENAME TO conversation_keys`);
    }

    // --- attachments ---
    const attDdl = raw.query(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'attachments'`,
    ).get() as { sql: string } | null;
    if (attDdl?.sql.includes('assistant_id')) {
      raw.exec(/*sql*/ `
        CREATE TABLE attachments_new (
          id TEXT PRIMARY KEY,
          original_filename TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          size_bytes INTEGER NOT NULL,
          kind TEXT NOT NULL,
          data_base64 TEXT NOT NULL,
          content_hash TEXT,
          thumbnail_base64 TEXT,
          created_at INTEGER NOT NULL
        )
      `);
      raw.exec(/*sql*/ `
        INSERT INTO attachments_new (id, original_filename, mime_type, size_bytes, kind, data_base64, content_hash, thumbnail_base64, created_at)
        SELECT id, original_filename, mime_type, size_bytes, kind, data_base64, content_hash, thumbnail_base64, created_at FROM attachments
      `);
      raw.exec(/*sql*/ `DROP TABLE attachments`);
      raw.exec(/*sql*/ `ALTER TABLE attachments_new RENAME TO attachments`);
    }

    // --- channel_inbound_events ---
    const cieDdl = raw.query(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'channel_inbound_events'`,
    ).get() as { sql: string } | null;
    if (cieDdl?.sql.includes('assistant_id')) {
      raw.exec(/*sql*/ `
        CREATE TABLE channel_inbound_events_new (
          id TEXT PRIMARY KEY,
          source_channel TEXT NOT NULL,
          external_chat_id TEXT NOT NULL,
          external_message_id TEXT NOT NULL,
          source_message_id TEXT,
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
          delivery_status TEXT NOT NULL DEFAULT 'pending',
          processing_status TEXT NOT NULL DEFAULT 'pending',
          processing_attempts INTEGER NOT NULL DEFAULT 0,
          last_processing_error TEXT,
          retry_after INTEGER,
          raw_payload TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE (source_channel, external_chat_id, external_message_id)
        )
      `);
      raw.exec(/*sql*/ `
        INSERT INTO channel_inbound_events_new (
          id, source_channel, external_chat_id, external_message_id, source_message_id,
          conversation_id, message_id, delivery_status, processing_status,
          processing_attempts, last_processing_error, retry_after, raw_payload,
          created_at, updated_at
        )
        SELECT
          id, source_channel, external_chat_id, external_message_id, source_message_id,
          conversation_id, message_id, delivery_status, processing_status,
          processing_attempts, last_processing_error, retry_after, raw_payload,
          created_at, updated_at
        FROM channel_inbound_events
      `);
      raw.exec(/*sql*/ `DROP TABLE channel_inbound_events`);
      raw.exec(/*sql*/ `ALTER TABLE channel_inbound_events_new RENAME TO channel_inbound_events`);
    }

    // --- message_runs ---
    const mrDdl = raw.query(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'message_runs'`,
    ).get() as { sql: string } | null;
    if (mrDdl?.sql.includes('assistant_id')) {
      raw.exec(/*sql*/ `
        CREATE TABLE message_runs_new (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
          status TEXT NOT NULL DEFAULT 'running',
          pending_confirmation TEXT,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          estimated_cost REAL NOT NULL DEFAULT 0,
          error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      raw.exec(/*sql*/ `
        INSERT INTO message_runs_new (
          id, conversation_id, message_id, status, pending_confirmation,
          input_tokens, output_tokens, estimated_cost, error, created_at, updated_at
        )
        SELECT
          id, conversation_id, message_id, status, pending_confirmation,
          input_tokens, output_tokens, estimated_cost, error, created_at, updated_at
        FROM message_runs
      `);
      raw.exec(/*sql*/ `DROP TABLE message_runs`);
      raw.exec(/*sql*/ `ALTER TABLE message_runs_new RENAME TO message_runs`);
    }

    // --- llm_usage_events ---
    const lueDdl = raw.query(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'llm_usage_events'`,
    ).get() as { sql: string } | null;
    if (lueDdl?.sql.includes('assistant_id')) {
      raw.exec(/*sql*/ `
        CREATE TABLE llm_usage_events_new (
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
          metadata_json TEXT
        )
      `);
      raw.exec(/*sql*/ `
        INSERT INTO llm_usage_events_new (
          id, created_at, conversation_id, run_id, request_id, actor, provider, model,
          input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens,
          estimated_cost_usd, pricing_status, metadata_json
        )
        SELECT
          id, created_at, conversation_id, run_id, request_id, actor, provider, model,
          input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens,
          estimated_cost_usd, pricing_status, metadata_json
        FROM llm_usage_events
      `);
      raw.exec(/*sql*/ `DROP TABLE llm_usage_events`);
      raw.exec(/*sql*/ `ALTER TABLE llm_usage_events_new RENAME TO llm_usage_events`);
    }

    raw.query(
      `INSERT OR IGNORE INTO memory_checkpoints (key, value, updated_at) VALUES (?, '1', ?)`,
    ).run(checkpointKey, Date.now());

    raw.exec('COMMIT');
  } catch (e) {
    try { raw.exec('ROLLBACK'); } catch { /* no active transaction */ }
    throw e;
  } finally {
    raw.exec('PRAGMA foreign_keys = ON');
  }
}

/**
 * One-shot migration: rebuild llm_usage_events to drop the assistant_id column.
 *
 * This is a SEPARATE migration from migrateRemoveAssistantIdColumns so that installs
 * where the 4-table version of that migration already ran (checkpoint already set)
 * still get the llm_usage_events column removed. Without a separate checkpoint key,
 * those installs would skip the llm_usage_events rebuild entirely.
 *
 * Safe on fresh installs (DDL guard exits early) and idempotent via checkpoint.
 */
export function migrateLlmUsageEventsDropAssistantId(database: Db): void {
  const raw = getSqliteFrom(database);
  const checkpointKey = 'migration_remove_assistant_id_lue_v1';
  const checkpoint = raw.query(
    `SELECT 1 FROM memory_checkpoints WHERE key = ?`,
  ).get(checkpointKey);
  if (checkpoint) return;

  // DDL guard: if the column was already removed (fresh install or migrateRemoveAssistantIdColumns
  // ran with the llm_usage_events block), just record the checkpoint and exit.
  const lueDdl = raw.query(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'llm_usage_events'`,
  ).get() as { sql: string } | null;

  if (!lueDdl?.sql.includes('assistant_id')) {
    raw.query(
      `INSERT OR IGNORE INTO memory_checkpoints (key, value, updated_at) VALUES (?, '1', ?)`,
    ).run(checkpointKey, Date.now());
    return;
  }

  raw.exec('PRAGMA foreign_keys = OFF');
  try {
    raw.exec('BEGIN');

    raw.exec(/*sql*/ `
      CREATE TABLE llm_usage_events_new (
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
        metadata_json TEXT
      )
    `);
    raw.exec(/*sql*/ `
      INSERT INTO llm_usage_events_new (
        id, created_at, conversation_id, run_id, request_id, actor, provider, model,
        input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens,
        estimated_cost_usd, pricing_status, metadata_json
      )
      SELECT
        id, created_at, conversation_id, run_id, request_id, actor, provider, model,
        input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens,
        estimated_cost_usd, pricing_status, metadata_json
      FROM llm_usage_events
    `);
    raw.exec(/*sql*/ `DROP TABLE llm_usage_events`);
    raw.exec(/*sql*/ `ALTER TABLE llm_usage_events_new RENAME TO llm_usage_events`);

    raw.query(
      `INSERT OR IGNORE INTO memory_checkpoints (key, value, updated_at) VALUES (?, '1', ?)`,
    ).run(checkpointKey, Date.now());

    raw.exec('COMMIT');
  } catch (e) {
    try { raw.exec('ROLLBACK'); } catch { /* no active transaction */ }
    throw e;
  } finally {
    raw.exec('PRAGMA foreign_keys = ON');
  }
}

/**
 * One-shot migration: deduplicate external_conversation_bindings rows that
 * share the same (source_channel, external_chat_id), then create a unique
 * index to enforce the invariant at DB level.
 *
 * For each duplicate group, the binding with the newest updatedAt (then
 * createdAt) is kept; older duplicates are deleted.
 */
export function migrateExtConvBindingsChannelChatUnique(database: Db): void {
  const raw = getSqliteFrom(database);

  // If the unique index already exists, nothing to do.
  const idxExists = raw.query(
    `SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_ext_conv_bindings_channel_chat_unique'`,
  ).get();
  if (idxExists) return;

  // Check if the table exists (first boot edge case).
  const tableExists = raw.query(
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'external_conversation_bindings'`,
  ).get();
  if (!tableExists) return;

  // Remove duplicates: keep the row with the newest updatedAt, then createdAt.
  // Since conversation_id is the PK (rowid alias), we use it for ordering ties.
  try {
    raw.exec('BEGIN');

    raw.exec(/*sql*/ `
      DELETE FROM external_conversation_bindings
      WHERE rowid NOT IN (
        SELECT rowid FROM (
          SELECT rowid,
                 ROW_NUMBER() OVER (
                   PARTITION BY source_channel, external_chat_id
                   ORDER BY updated_at DESC, created_at DESC, rowid DESC
                 ) AS rn
          FROM external_conversation_bindings
        )
        WHERE rn = 1
      )
    `);

    raw.exec(/*sql*/ `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ext_conv_bindings_channel_chat_unique
      ON external_conversation_bindings(source_channel, external_chat_id)
    `);

    raw.exec('COMMIT');
  } catch (e) {
    try { raw.exec('ROLLBACK'); } catch { /* no active transaction */ }
    throw e;
  }
}

/**
 * One-shot migration: remove duplicate (provider, provider_call_sid) rows from
 * call_sessions so that the unique index can be created safely on upgraded databases
 * that pre-date the constraint.
 *
 * For each set of duplicates, the most recently updated row is kept.
 */
export function migrateCallSessionsProviderSidDedup(database: Db): void {
  const raw = getSqliteFrom(database);

  // Quick check: if the unique index already exists, no dedup is needed.
  const idxExists = raw.query(
    `SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_call_sessions_provider_sid_unique'`,
  ).get();
  if (idxExists) return;

  // Check if the table even exists yet (first boot).
  const tableExists = raw.query(
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'call_sessions'`,
  ).get();
  if (!tableExists) return;

  // Count duplicates before doing any work.
  const dupCount = raw.query(/*sql*/ `
    SELECT COUNT(*) AS c FROM (
      SELECT provider, provider_call_sid
      FROM call_sessions
      WHERE provider_call_sid IS NOT NULL
      GROUP BY provider, provider_call_sid
      HAVING COUNT(*) > 1
    )
  `).get() as { c: number } | null;

  if (!dupCount || dupCount.c === 0) return;

  log.warn({ duplicateGroups: dupCount.c }, 'Deduplicating call_sessions with duplicate provider_call_sid before creating unique index');

  try {
    raw.exec('BEGIN');

    // Keep the most recently updated row per (provider, provider_call_sid);
    // delete the rest.
    raw.exec(/*sql*/ `
      DELETE FROM call_sessions
      WHERE provider_call_sid IS NOT NULL
        AND rowid NOT IN (
          SELECT MAX(rowid) FROM call_sessions
          WHERE provider_call_sid IS NOT NULL
          GROUP BY provider, provider_call_sid
        )
    `);

    raw.exec('COMMIT');
  } catch (e) {
    try { raw.exec('ROLLBACK'); } catch { /* no active transaction */ }
    throw e;
  }
}

/**
 * Add the `initiated_from_conversation_id` column to `call_sessions` so
 * voice calls can track which conversation triggered them while pointing
 * the session's `conversation_id` to a dedicated per-call voice conversation.
 *
 * Uses ALTER TABLE ... ADD COLUMN which is a no-op if the column already
 * exists (caught via try/catch, matching the existing migration pattern in
 * db-init.ts for similar additive columns).
 */
export function migrateCallSessionsAddInitiatedFrom(database: Db): void {
  const raw = getSqliteFrom(database);
  try {
    raw.exec(/*sql*/ `ALTER TABLE call_sessions ADD COLUMN initiated_from_conversation_id TEXT`);
  } catch {
    // Column already exists — nothing to do.
  }
}

/**
 * Create guardian_action_requests and guardian_action_deliveries tables
 * for cross-channel voice guardian dispatch.
 *
 * Uses CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS for
 * idempotency across restarts.
 */
export function migrateGuardianActionTables(database: Db): void {
  const raw = getSqliteFrom(database);

  raw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS guardian_action_requests (
      id TEXT PRIMARY KEY,
      assistant_id TEXT NOT NULL DEFAULT 'self',
      kind TEXT NOT NULL,
      source_channel TEXT NOT NULL,
      source_conversation_id TEXT NOT NULL,
      call_session_id TEXT NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
      pending_question_id TEXT NOT NULL REFERENCES call_pending_questions(id) ON DELETE CASCADE,
      question_text TEXT NOT NULL,
      request_code TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      answer_text TEXT,
      answered_by_channel TEXT,
      answered_by_external_user_id TEXT,
      answered_at INTEGER,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  raw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS guardian_action_deliveries (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL REFERENCES guardian_action_requests(id) ON DELETE CASCADE,
      destination_channel TEXT NOT NULL,
      destination_conversation_id TEXT,
      destination_chat_id TEXT,
      destination_external_user_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      sent_at INTEGER,
      responded_at INTEGER,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  raw.exec(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_guardian_action_requests_status ON guardian_action_requests(status)`);
  raw.exec(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_guardian_action_requests_call_session ON guardian_action_requests(call_session_id)`);
  raw.exec(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_guardian_action_requests_pending_question ON guardian_action_requests(pending_question_id)`);
  raw.exec(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_guardian_action_requests_request_code ON guardian_action_requests(request_code)`);
  raw.exec(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_guardian_action_deliveries_request_id ON guardian_action_deliveries(request_id)`);
  raw.exec(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_guardian_action_deliveries_status ON guardian_action_deliveries(status)`);
  raw.exec(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_guardian_action_deliveries_destination ON guardian_action_deliveries(destination_channel, destination_chat_id)`);
}
