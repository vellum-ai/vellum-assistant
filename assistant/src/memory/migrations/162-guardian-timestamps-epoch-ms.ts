import { getLogger } from "../../util/logger.js";
import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

const log = getLogger("migration-162");

/**
 * Convert guardian table timestamps from ISO 8601 text to epoch ms integers,
 * then rebuild the tables so that timestamp columns have INTEGER affinity.
 *
 * The `canonical_guardian_requests`, `canonical_guardian_deliveries`, and
 * `scoped_approval_grants` tables were originally created with TEXT columns
 * for timestamps. Migration step 1 converts existing data values in-place,
 * and step 2 rebuilds the tables so the column declarations use INTEGER.
 * Without the rebuild, SQLite's TEXT affinity coerces the integer values
 * back to text strings on read, causing downstream code (e.g.
 * `new Date(req.expiresAt).getTime()`) to produce NaN.
 */
export function migrateGuardianTimestampsEpochMs(database: DrizzleDb): void {
  // Step 1: Convert existing text timestamps to integer epoch ms values.
  withCrashRecovery(
    database,
    "migration_guardian_timestamps_epoch_ms_v1",
    () => {
      const raw = getSqliteFrom(database);

      // Convert canonical_guardian_requests timestamp columns
      raw.exec(/*sql*/ `
      UPDATE canonical_guardian_requests
      SET created_at = CAST(strftime('%s', created_at) AS INTEGER) * 1000 + CAST(substr(created_at, 21, 3) AS INTEGER),
          updated_at = CAST(strftime('%s', updated_at) AS INTEGER) * 1000 + CAST(substr(updated_at, 21, 3) AS INTEGER),
          expires_at = CASE
            WHEN expires_at IS NOT NULL
            THEN CAST(strftime('%s', expires_at) AS INTEGER) * 1000 + CAST(substr(expires_at, 21, 3) AS INTEGER)
            ELSE NULL
          END
      WHERE typeof(created_at) = 'text'
    `);

      // Convert canonical_guardian_deliveries timestamp columns
      raw.exec(/*sql*/ `
      UPDATE canonical_guardian_deliveries
      SET created_at = CAST(strftime('%s', created_at) AS INTEGER) * 1000 + CAST(substr(created_at, 21, 3) AS INTEGER),
          updated_at = CAST(strftime('%s', updated_at) AS INTEGER) * 1000 + CAST(substr(updated_at, 21, 3) AS INTEGER)
      WHERE typeof(created_at) = 'text'
    `);

      // Convert scoped_approval_grants timestamp columns
      raw.exec(/*sql*/ `
      UPDATE scoped_approval_grants
      SET expires_at = CAST(strftime('%s', expires_at) AS INTEGER) * 1000 + CAST(substr(expires_at, 21, 3) AS INTEGER),
          created_at = CAST(strftime('%s', created_at) AS INTEGER) * 1000 + CAST(substr(created_at, 21, 3) AS INTEGER),
          updated_at = CAST(strftime('%s', updated_at) AS INTEGER) * 1000 + CAST(substr(updated_at, 21, 3) AS INTEGER),
          consumed_at = CASE
            WHEN consumed_at IS NOT NULL
            THEN CAST(strftime('%s', consumed_at) AS INTEGER) * 1000 + CAST(substr(consumed_at, 21, 3) AS INTEGER)
            ELSE NULL
          END
      WHERE typeof(created_at) = 'text'
    `);

      log.info(
        "Converted guardian table timestamps from ISO 8601 text to epoch ms",
      );
    },
  );

  // Step 2: Rebuild tables so timestamp columns have INTEGER affinity.
  // Databases created before the CREATE TABLE migrations were updated still
  // have TEXT affinity on these columns, which coerces integer values back
  // to text strings on read.
  withCrashRecovery(
    database,
    "migration_guardian_timestamps_rebuild_v1",
    () => {
      const raw = getSqliteFrom(database);

      rebuildCanonicalGuardianRequests(raw);
      rebuildCanonicalGuardianDeliveries(raw);
      rebuildScopedApprovalGrants(raw);

      log.info(
        "Rebuilt guardian tables with INTEGER affinity on timestamp columns",
      );
    },
  );
}

// ---------------------------------------------------------------------------
// Table rebuild helpers
// ---------------------------------------------------------------------------

type RawDb = ReturnType<typeof getSqliteFrom>;

function hasIntegerAffinity(
  raw: RawDb,
  table: string,
  column: string,
): boolean {
  const row = raw
    .query(
      `SELECT type FROM pragma_table_info('${table}') WHERE name = '${column}'`,
    )
    .get() as { type: string } | null;
  if (!row) return true; // column doesn't exist — nothing to fix
  return row.type.toUpperCase() === "INTEGER";
}

function rebuildCanonicalGuardianRequests(raw: RawDb): void {
  if (hasIntegerAffinity(raw, "canonical_guardian_requests", "created_at"))
    return;

  raw.exec("PRAGMA foreign_keys = OFF");
  try {
    raw.exec(/*sql*/ `
      BEGIN;

      CREATE TABLE canonical_guardian_requests_new (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_channel TEXT,
        conversation_id TEXT,
        requester_external_user_id TEXT,
        requester_chat_id TEXT,
        guardian_external_user_id TEXT,
        guardian_principal_id TEXT,
        call_session_id TEXT,
        pending_question_id TEXT,
        question_text TEXT,
        request_code TEXT,
        tool_name TEXT,
        input_digest TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        answer_text TEXT,
        decided_by_external_user_id TEXT,
        decided_by_principal_id TEXT,
        followup_state TEXT,
        expires_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      INSERT INTO canonical_guardian_requests_new
      SELECT id, kind, source_type, source_channel, conversation_id,
             requester_external_user_id, requester_chat_id,
             guardian_external_user_id, guardian_principal_id,
             call_session_id, pending_question_id, question_text,
             request_code, tool_name, input_digest, status, answer_text,
             decided_by_external_user_id, decided_by_principal_id,
             followup_state, expires_at, created_at, updated_at
      FROM canonical_guardian_requests;

      DROP TABLE canonical_guardian_requests;
      ALTER TABLE canonical_guardian_requests_new RENAME TO canonical_guardian_requests;

      CREATE INDEX IF NOT EXISTS idx_canonical_guardian_requests_status ON canonical_guardian_requests(status);
      CREATE INDEX IF NOT EXISTS idx_canonical_guardian_requests_guardian ON canonical_guardian_requests(guardian_external_user_id, status);
      CREATE INDEX IF NOT EXISTS idx_canonical_guardian_requests_conversation ON canonical_guardian_requests(conversation_id, status);
      CREATE INDEX IF NOT EXISTS idx_canonical_guardian_requests_source ON canonical_guardian_requests(source_type, status);
      CREATE INDEX IF NOT EXISTS idx_canonical_guardian_requests_kind ON canonical_guardian_requests(kind, status);
      CREATE INDEX IF NOT EXISTS idx_canonical_guardian_requests_request_code ON canonical_guardian_requests(request_code);

      COMMIT;
    `);
  } catch (e) {
    try {
      raw.exec("ROLLBACK");
    } catch {
      /* no active transaction */
    }
    throw e;
  } finally {
    raw.exec("PRAGMA foreign_keys = ON");
  }
}

function rebuildCanonicalGuardianDeliveries(raw: RawDb): void {
  if (hasIntegerAffinity(raw, "canonical_guardian_deliveries", "created_at"))
    return;

  raw.exec("PRAGMA foreign_keys = OFF");
  try {
    raw.exec(/*sql*/ `
      BEGIN;

      CREATE TABLE canonical_guardian_deliveries_new (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL REFERENCES canonical_guardian_requests(id) ON DELETE CASCADE,
        destination_channel TEXT NOT NULL,
        destination_conversation_id TEXT,
        destination_chat_id TEXT,
        destination_message_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      INSERT INTO canonical_guardian_deliveries_new
      SELECT id, request_id, destination_channel, destination_conversation_id,
             destination_chat_id, destination_message_id, status,
             created_at, updated_at
      FROM canonical_guardian_deliveries;

      DROP TABLE canonical_guardian_deliveries;
      ALTER TABLE canonical_guardian_deliveries_new RENAME TO canonical_guardian_deliveries;

      CREATE INDEX IF NOT EXISTS idx_canonical_guardian_deliveries_request_id ON canonical_guardian_deliveries(request_id);
      CREATE INDEX IF NOT EXISTS idx_canonical_guardian_deliveries_status ON canonical_guardian_deliveries(status);
      CREATE INDEX IF NOT EXISTS idx_canonical_guardian_deliveries_destination ON canonical_guardian_deliveries(destination_channel, destination_chat_id);

      COMMIT;
    `);
  } catch (e) {
    try {
      raw.exec("ROLLBACK");
    } catch {
      /* no active transaction */
    }
    throw e;
  } finally {
    raw.exec("PRAGMA foreign_keys = ON");
  }
}

function rebuildScopedApprovalGrants(raw: RawDb): void {
  if (hasIntegerAffinity(raw, "scoped_approval_grants", "created_at")) return;

  raw.exec("PRAGMA foreign_keys = OFF");
  try {
    raw.exec(/*sql*/ `
      BEGIN;

      CREATE TABLE scoped_approval_grants_new (
        id TEXT PRIMARY KEY,
        scope_mode TEXT NOT NULL,
        request_id TEXT,
        tool_name TEXT,
        input_digest TEXT,
        request_channel TEXT NOT NULL,
        decision_channel TEXT NOT NULL,
        execution_channel TEXT,
        conversation_id TEXT,
        call_session_id TEXT,
        requester_external_user_id TEXT,
        guardian_external_user_id TEXT,
        status TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER,
        consumed_by_request_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      INSERT INTO scoped_approval_grants_new
      SELECT id, scope_mode, request_id, tool_name, input_digest,
             request_channel, decision_channel, execution_channel,
             conversation_id, call_session_id,
             requester_external_user_id, guardian_external_user_id,
             status, expires_at, consumed_at, consumed_by_request_id,
             created_at, updated_at
      FROM scoped_approval_grants;

      DROP TABLE scoped_approval_grants;
      ALTER TABLE scoped_approval_grants_new RENAME TO scoped_approval_grants;

      CREATE INDEX IF NOT EXISTS idx_scoped_grants_request_id ON scoped_approval_grants(request_id) WHERE request_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_scoped_grants_tool_sig ON scoped_approval_grants(tool_name, input_digest) WHERE tool_name IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_scoped_grants_status_expires ON scoped_approval_grants(status, expires_at);

      COMMIT;
    `);
  } catch (e) {
    try {
      raw.exec("ROLLBACK");
    } catch {
      /* no active transaction */
    }
    throw e;
  } finally {
    raw.exec("PRAGMA foreign_keys = ON");
  }
}

// ---------------------------------------------------------------------------
// Down functions
// ---------------------------------------------------------------------------

/**
 * Reverse v29: convert epoch ms timestamps back to ISO 8601 text in guardian
 * tables.
 *
 * Uses SQLite's datetime() to reconstruct ISO 8601 strings from the integer
 * values. The millisecond component is appended manually since datetime()
 * only returns second precision.
 */
export function migrateGuardianTimestampsEpochMsDown(
  database: DrizzleDb,
): void {
  const raw = getSqliteFrom(database);

  // Convert canonical_guardian_requests timestamp columns back to ISO 8601
  raw.exec(/*sql*/ `
    UPDATE canonical_guardian_requests
    SET created_at = strftime('%Y-%m-%dT%H:%M:%S', created_at / 1000, 'unixepoch') || '.' || printf('%03d', created_at % 1000) || 'Z',
        updated_at = strftime('%Y-%m-%dT%H:%M:%S', updated_at / 1000, 'unixepoch') || '.' || printf('%03d', updated_at % 1000) || 'Z',
        expires_at = CASE
          WHEN expires_at IS NOT NULL
          THEN strftime('%Y-%m-%dT%H:%M:%S', expires_at / 1000, 'unixepoch') || '.' || printf('%03d', expires_at % 1000) || 'Z'
          ELSE NULL
        END
    WHERE typeof(created_at) = 'integer'
  `);

  // Convert canonical_guardian_deliveries timestamp columns back to ISO 8601
  raw.exec(/*sql*/ `
    UPDATE canonical_guardian_deliveries
    SET created_at = strftime('%Y-%m-%dT%H:%M:%S', created_at / 1000, 'unixepoch') || '.' || printf('%03d', created_at % 1000) || 'Z',
        updated_at = strftime('%Y-%m-%dT%H:%M:%S', updated_at / 1000, 'unixepoch') || '.' || printf('%03d', updated_at % 1000) || 'Z'
    WHERE typeof(created_at) = 'integer'
  `);

  // Convert scoped_approval_grants timestamp columns back to ISO 8601
  raw.exec(/*sql*/ `
    UPDATE scoped_approval_grants
    SET expires_at = strftime('%Y-%m-%dT%H:%M:%S', expires_at / 1000, 'unixepoch') || '.' || printf('%03d', expires_at % 1000) || 'Z',
        created_at = strftime('%Y-%m-%dT%H:%M:%S', created_at / 1000, 'unixepoch') || '.' || printf('%03d', created_at % 1000) || 'Z',
        updated_at = strftime('%Y-%m-%dT%H:%M:%S', updated_at / 1000, 'unixepoch') || '.' || printf('%03d', updated_at % 1000) || 'Z',
        consumed_at = CASE
          WHEN consumed_at IS NOT NULL
          THEN strftime('%Y-%m-%dT%H:%M:%S', consumed_at / 1000, 'unixepoch') || '.' || printf('%03d', consumed_at % 1000) || 'Z'
          ELSE NULL
        END
    WHERE typeof(created_at) = 'integer'
  `);
}

/**
 * Reverse v30: rebuild guardian tables with TEXT affinity on timestamp columns.
 *
 * Restores the original TEXT column declarations so that timestamp columns
 * have TEXT affinity (the state before the INTEGER rebuild).
 */
export function migrateGuardianTimestampsRebuildDown(
  database: DrizzleDb,
): void {
  const raw = getSqliteFrom(database);

  rebuildCanonicalGuardianRequestsToText(raw);
  rebuildCanonicalGuardianDeliveriesToText(raw);
  rebuildScopedApprovalGrantsToText(raw);
}

function hasTextAffinity(raw: RawDb, table: string, column: string): boolean {
  const row = raw
    .query(
      `SELECT type FROM pragma_table_info('${table}') WHERE name = '${column}'`,
    )
    .get() as { type: string } | null;
  if (!row) return true; // column doesn't exist — nothing to fix
  return row.type.toUpperCase() === "TEXT";
}

function rebuildCanonicalGuardianRequestsToText(raw: RawDb): void {
  if (hasTextAffinity(raw, "canonical_guardian_requests", "created_at")) return;

  raw.exec("PRAGMA foreign_keys = OFF");
  try {
    raw.exec("BEGIN");

    raw.exec(/*sql*/ `
      CREATE TABLE canonical_guardian_requests_rb (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_channel TEXT,
        conversation_id TEXT,
        requester_external_user_id TEXT,
        requester_chat_id TEXT,
        guardian_external_user_id TEXT,
        guardian_principal_id TEXT,
        call_session_id TEXT,
        pending_question_id TEXT,
        question_text TEXT,
        request_code TEXT,
        tool_name TEXT,
        input_digest TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        answer_text TEXT,
        decided_by_external_user_id TEXT,
        decided_by_principal_id TEXT,
        followup_state TEXT,
        expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    raw.exec(/*sql*/ `
      INSERT INTO canonical_guardian_requests_rb
      SELECT id, kind, source_type, source_channel, conversation_id,
             requester_external_user_id, requester_chat_id,
             guardian_external_user_id, guardian_principal_id,
             call_session_id, pending_question_id, question_text,
             request_code, tool_name, input_digest, status, answer_text,
             decided_by_external_user_id, decided_by_principal_id,
             followup_state, expires_at, created_at, updated_at
      FROM canonical_guardian_requests
    `);

    raw.exec(/*sql*/ `DROP TABLE canonical_guardian_requests`);
    raw.exec(
      /*sql*/ `ALTER TABLE canonical_guardian_requests_rb RENAME TO canonical_guardian_requests`,
    );

    raw.exec(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_canonical_guardian_requests_status ON canonical_guardian_requests(status)`,
    );
    raw.exec(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_canonical_guardian_requests_guardian ON canonical_guardian_requests(guardian_external_user_id, status)`,
    );
    raw.exec(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_canonical_guardian_requests_conversation ON canonical_guardian_requests(conversation_id, status)`,
    );
    raw.exec(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_canonical_guardian_requests_source ON canonical_guardian_requests(source_type, status)`,
    );
    raw.exec(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_canonical_guardian_requests_kind ON canonical_guardian_requests(kind, status)`,
    );
    raw.exec(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_canonical_guardian_requests_request_code ON canonical_guardian_requests(request_code)`,
    );

    raw.exec("COMMIT");
  } catch (e) {
    try {
      raw.exec("ROLLBACK");
    } catch {
      /* no active transaction */
    }
    throw e;
  } finally {
    raw.exec("PRAGMA foreign_keys = ON");
  }
}

function rebuildCanonicalGuardianDeliveriesToText(raw: RawDb): void {
  if (hasTextAffinity(raw, "canonical_guardian_deliveries", "created_at"))
    return;

  raw.exec("PRAGMA foreign_keys = OFF");
  try {
    raw.exec("BEGIN");

    raw.exec(/*sql*/ `
      CREATE TABLE canonical_guardian_deliveries_rb (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL REFERENCES canonical_guardian_requests(id) ON DELETE CASCADE,
        destination_channel TEXT NOT NULL,
        destination_conversation_id TEXT,
        destination_chat_id TEXT,
        destination_message_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    raw.exec(/*sql*/ `
      INSERT INTO canonical_guardian_deliveries_rb
      SELECT id, request_id, destination_channel, destination_conversation_id,
             destination_chat_id, destination_message_id, status,
             created_at, updated_at
      FROM canonical_guardian_deliveries
    `);

    raw.exec(/*sql*/ `DROP TABLE canonical_guardian_deliveries`);
    raw.exec(
      /*sql*/ `ALTER TABLE canonical_guardian_deliveries_rb RENAME TO canonical_guardian_deliveries`,
    );

    raw.exec(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_canonical_guardian_deliveries_request_id ON canonical_guardian_deliveries(request_id)`,
    );
    raw.exec(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_canonical_guardian_deliveries_status ON canonical_guardian_deliveries(status)`,
    );
    raw.exec(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_canonical_guardian_deliveries_destination ON canonical_guardian_deliveries(destination_channel, destination_chat_id)`,
    );

    raw.exec("COMMIT");
  } catch (e) {
    try {
      raw.exec("ROLLBACK");
    } catch {
      /* no active transaction */
    }
    throw e;
  } finally {
    raw.exec("PRAGMA foreign_keys = ON");
  }
}

function rebuildScopedApprovalGrantsToText(raw: RawDb): void {
  if (hasTextAffinity(raw, "scoped_approval_grants", "created_at")) return;

  raw.exec("PRAGMA foreign_keys = OFF");
  try {
    raw.exec("BEGIN");

    raw.exec(/*sql*/ `
      CREATE TABLE scoped_approval_grants_rb (
        id TEXT PRIMARY KEY,
        scope_mode TEXT NOT NULL,
        request_id TEXT,
        tool_name TEXT,
        input_digest TEXT,
        request_channel TEXT NOT NULL,
        decision_channel TEXT NOT NULL,
        execution_channel TEXT,
        conversation_id TEXT,
        call_session_id TEXT,
        requester_external_user_id TEXT,
        guardian_external_user_id TEXT,
        status TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        consumed_by_request_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    raw.exec(/*sql*/ `
      INSERT INTO scoped_approval_grants_rb
      SELECT id, scope_mode, request_id, tool_name, input_digest,
             request_channel, decision_channel, execution_channel,
             conversation_id, call_session_id,
             requester_external_user_id, guardian_external_user_id,
             status, expires_at, consumed_at, consumed_by_request_id,
             created_at, updated_at
      FROM scoped_approval_grants
    `);

    raw.exec(/*sql*/ `DROP TABLE scoped_approval_grants`);
    raw.exec(
      /*sql*/ `ALTER TABLE scoped_approval_grants_rb RENAME TO scoped_approval_grants`,
    );

    raw.exec(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_scoped_grants_request_id ON scoped_approval_grants(request_id) WHERE request_id IS NOT NULL`,
    );
    raw.exec(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_scoped_grants_tool_sig ON scoped_approval_grants(tool_name, input_digest) WHERE tool_name IS NOT NULL`,
    );
    raw.exec(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_scoped_grants_status_expires ON scoped_approval_grants(status, expires_at)`,
    );

    raw.exec("COMMIT");
  } catch (e) {
    try {
      raw.exec("ROLLBACK");
    } catch {
      /* no active transaction */
    }
    throw e;
  } finally {
    raw.exec("PRAGMA foreign_keys = ON");
  }
}
