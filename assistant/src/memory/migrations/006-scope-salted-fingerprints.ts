import { createHash } from "node:crypto";

import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";
import { computeMemoryFingerprint } from "../fingerprint.js";

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
export function migrateMemoryItemsScopeSaltedFingerprints(
  database: DrizzleDb,
): void {
  const raw = getSqliteFrom(database);
  const checkpointKey = "migration_memory_items_scope_salted_fingerprints_v1";
  const checkpoint = raw
    .query(`SELECT 1 FROM memory_checkpoints WHERE key = ?`)
    .get(checkpointKey);
  if (checkpoint) return;

  interface ItemRow {
    id: string;
    kind: string;
    subject: string;
    statement: string;
    scope_id: string;
  }

  const items = raw
    .query(`SELECT id, kind, subject, statement, scope_id FROM memory_items`)
    .all() as ItemRow[];

  if (items.length === 0) {
    raw
      .query(
        `INSERT OR IGNORE INTO memory_checkpoints (key, value, updated_at) VALUES (?, '1', ?)`,
      )
      .run(checkpointKey, Date.now());
    return;
  }

  try {
    raw.exec("BEGIN");

    const updateStmt = raw.prepare(
      `UPDATE memory_items SET fingerprint = ? WHERE id = ?`,
    );

    for (const item of items) {
      const fingerprint = computeMemoryFingerprint(
        item.scope_id,
        item.kind,
        item.subject,
        item.statement,
      );
      updateStmt.run(fingerprint, item.id);
    }

    raw
      .query(
        `INSERT OR IGNORE INTO memory_checkpoints (key, value, updated_at) VALUES (?, '1', ?)`,
      )
      .run(checkpointKey, Date.now());

    raw.exec("COMMIT");
  } catch (e) {
    try {
      raw.exec("ROLLBACK");
    } catch {
      /* no active transaction */
    }
    throw e;
  }
}

/**
 * Reverse the scope-salted fingerprint migration by recomputing fingerprints
 * WITHOUT the scope_id prefix.
 *
 * Old format: sha256(`${kind}|${subject.toLowerCase()}|${statement.toLowerCase()}`)
 */
export function downMemoryItemsScopeSaltedFingerprints(
  database: DrizzleDb,
): void {
  const raw = getSqliteFrom(database);

  interface ItemRow {
    id: string;
    kind: string;
    subject: string;
    statement: string;
  }

  const items = raw
    .query(`SELECT id, kind, subject, statement FROM memory_items`)
    .all() as ItemRow[];

  if (items.length === 0) return;

  try {
    raw.exec("BEGIN");

    const updateStmt = raw.prepare(
      `UPDATE memory_items SET fingerprint = ? WHERE id = ?`,
    );

    for (const item of items) {
      const normalized = `${item.kind}|${item.subject.toLowerCase()}|${item.statement.toLowerCase()}`;
      const fingerprint = createHash("sha256").update(normalized).digest("hex");
      updateStmt.run(fingerprint, item.id);
    }

    raw.exec("COMMIT");
  } catch (e) {
    try {
      raw.exec("ROLLBACK");
    } catch {
      /* no active transaction */
    }
    throw e;
  }
}
