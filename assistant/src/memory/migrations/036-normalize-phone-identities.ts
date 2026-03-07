import { normalizePhoneNumber } from "../../util/phone.js";
import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

/**
 * One-shot migration: normalize phone-like identity fields to E.164 format.
 *
 * Historical records may contain phone numbers in inconsistent formats
 * (e.g., "(555) 123-4567", "1-555-123-4567", "+1 555 123 4567").
 * This migration normalizes them to E.164 ("+15551234567") using the same
 * normalizePhoneNumber utility used at runtime.
 *
 * Strategy:
 *   - Tables with a `channel` column: only process rows where the channel
 *     is phone-like (sms, voice, whatsapp).
 *   - The `expected_phone_e164` column is always a phone number regardless
 *     of channel, so it is normalized unconditionally.
 *
 * Collision handling: source queries are ordered by `updated_at DESC`
 * (falling back to `rowid DESC` when the column is absent) so the
 * most-recently-updated row is processed first and receives the UPDATE.
 * When a subsequent (older) duplicate normalizes to the same value
 * within the same unique-key scope, it is deleted — preserving the
 * most recent state deterministically.
 *
 * Idempotent: already-normalized values pass through normalizePhoneNumber
 * unchanged, and the checkpoint key prevents re-execution.
 */
export function migrateNormalizePhoneIdentities(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  const checkpointKey = "migration_normalize_phone_identities_v1";
  const checkpoint = raw
    .query(`SELECT 1 FROM memory_checkpoints WHERE key = ?`)
    .get(checkpointKey);
  if (checkpoint) return;

  const PHONE_CHANNELS = ["sms", "phone", "whatsapp"];

  /**
   * Unique key scope definition for collision detection.
   * `peerColumns` are the other columns in the composite unique index
   * (besides the column being normalized). When the normalized value
   * matches an existing row with the same peer-column values, the
   * current row is a duplicate and should be deleted.
   * `whereClause` is an optional SQL fragment for partial unique indexes
   * (e.g., `WHERE external_user_id IS NOT NULL`).
   */
  type UniqueKeyScope = {
    peerColumns: string[];
    whereClause?: string;
  };

  // Helper: normalize a column's phone-like values in a table filtered by channel.
  // When uniqueKeyScope is provided, checks for collisions before updating.
  // Rows are ordered by updated_at DESC (or rowid DESC as fallback) so the
  // most-recently-updated row is processed first and survives collisions.
  function normalizeColumnByChannel(
    table: string,
    column: string,
    channelColumn: string,
    uniqueKeyScope?: UniqueKeyScope,
  ): void {
    const tableExists = raw
      .query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(table);
    if (!tableExists) return;

    const colExists = raw
      .query(`SELECT 1 FROM pragma_table_info(?) WHERE name = ?`)
      .get(table, column);
    if (!colExists) return;

    const chanColExists = raw
      .query(`SELECT 1 FROM pragma_table_info(?) WHERE name = ?`)
      .get(table, channelColumn);
    if (!chanColExists) return;

    const hasUpdatedAt = !!raw
      .query(`SELECT 1 FROM pragma_table_info(?) WHERE name = 'updated_at'`)
      .get(table);
    const orderBy = hasUpdatedAt ? "updated_at DESC, rowid DESC" : "rowid DESC";

    const selectColumns = [`id`, column];
    if (uniqueKeyScope) {
      for (const peer of uniqueKeyScope.peerColumns) {
        if (!selectColumns.includes(peer)) selectColumns.push(peer);
      }
    }

    const rows = raw
      .query(
        `SELECT ${selectColumns.join(", ")} FROM ${table} WHERE ${channelColumn} IN (${PHONE_CHANNELS.map(() => "?").join(",")}) AND ${column} IS NOT NULL ORDER BY ${orderBy}`,
      )
      .all(...PHONE_CHANNELS) as Array<{ id: string; [key: string]: string }>;

    if (rows.length === 0) return;

    const update = raw.prepare(
      `UPDATE ${table} SET ${column} = ? WHERE id = ?`,
    );
    const deleteRow = raw.prepare(`DELETE FROM ${table} WHERE id = ?`);

    for (const row of rows) {
      const original = row[column];
      if (!original) continue;
      const normalized = normalizePhoneNumber(original);
      if (normalized && normalized !== original) {
        if (uniqueKeyScope) {
          // Check if another row already has the normalized value within the same unique-key scope
          const peerConditions = uniqueKeyScope.peerColumns
            .map((col) => `${col} = ?`)
            .join(" AND ");
          const peerValues = uniqueKeyScope.peerColumns.map((col) => row[col]);
          const whereExtra = uniqueKeyScope.whereClause
            ? ` AND (${uniqueKeyScope.whereClause})`
            : "";
          const existing = raw
            .query(
              `SELECT 1 FROM ${table} WHERE ${column} = ? AND ${peerConditions} AND id != ?${whereExtra}`,
            )
            .get(normalized, ...peerValues, row.id);
          if (existing) {
            // A canonical row already exists — delete this duplicate
            deleteRow.run(row.id);
            continue;
          }
        }
        update.run(normalized, row.id);
      }
    }
  }

  // Helper: normalize a column unconditionally (no channel filter).
  // Used for columns that are always phone numbers (e.g., expected_phone_e164).
  // When uniqueKeyScope is provided, checks for collisions before updating.
  // Rows are ordered by updated_at DESC (or rowid DESC as fallback) so the
  // most-recently-updated row is processed first and survives collisions.
  function normalizeColumnUnconditionally(
    table: string,
    column: string,
    uniqueKeyScope?: UniqueKeyScope,
  ): void {
    const tableExists = raw
      .query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(table);
    if (!tableExists) return;

    const colExists = raw
      .query(`SELECT 1 FROM pragma_table_info(?) WHERE name = ?`)
      .get(table, column);
    if (!colExists) return;

    const hasUpdatedAt = !!raw
      .query(`SELECT 1 FROM pragma_table_info(?) WHERE name = 'updated_at'`)
      .get(table);
    const orderBy = hasUpdatedAt ? "updated_at DESC, rowid DESC" : "rowid DESC";

    const selectColumns = [`id`, column];
    if (uniqueKeyScope) {
      for (const peer of uniqueKeyScope.peerColumns) {
        if (!selectColumns.includes(peer)) selectColumns.push(peer);
      }
    }

    const rows = raw
      .query(
        `SELECT ${selectColumns.join(", ")} FROM ${table} WHERE ${column} IS NOT NULL ORDER BY ${orderBy}`,
      )
      .all() as Array<{ id: string; [key: string]: string }>;

    if (rows.length === 0) return;

    const update = raw.prepare(
      `UPDATE ${table} SET ${column} = ? WHERE id = ?`,
    );
    const deleteRow = raw.prepare(`DELETE FROM ${table} WHERE id = ?`);

    for (const row of rows) {
      const original = row[column];
      if (!original) continue;
      const normalized = normalizePhoneNumber(original);
      if (normalized && normalized !== original) {
        if (uniqueKeyScope) {
          const peerConditions = uniqueKeyScope.peerColumns
            .map((col) => `${col} = ?`)
            .join(" AND ");
          const peerValues = uniqueKeyScope.peerColumns.map((col) => row[col]);
          const whereExtra = uniqueKeyScope.whereClause
            ? ` AND (${uniqueKeyScope.whereClause})`
            : "";
          const existing = raw
            .query(
              `SELECT 1 FROM ${table} WHERE ${column} = ? AND ${peerConditions} AND id != ?${whereExtra}`,
            )
            .get(normalized, ...peerValues, row.id);
          if (existing) {
            deleteRow.run(row.id);
            continue;
          }
        }
        update.run(normalized, row.id);
      }
    }
  }

  try {
    raw.exec("BEGIN");

    // ── channel_guardian_bindings ──────────────────────────────────
    // Has `channel` column — only normalize phone-like channels.
    // Unique index idx_channel_guardian_bindings_active is on (assistant_id, channel)
    // and does NOT include guardian_external_user_id, so no collision risk.
    normalizeColumnByChannel(
      "channel_guardian_bindings",
      "guardian_external_user_id",
      "channel",
    );

    // ── assistant_ingress_members ─────────────────────────────────
    // Has `source_channel` column — only normalize phone-like channels.
    // Unique index idx_ingress_members_user is on (assistant_id, source_channel, external_user_id)
    // WHERE external_user_id IS NOT NULL — collision possible when two format variants normalize
    // to the same E.164 within the same (assistant_id, source_channel) scope.
    normalizeColumnByChannel(
      "assistant_ingress_members",
      "external_user_id",
      "source_channel",
      {
        peerColumns: ["assistant_id", "source_channel"],
        whereClause: "external_user_id IS NOT NULL",
      },
    );

    // ── channel_guardian_verification_challenges ──────────────────
    // Has `channel` column — normalize identity columns for phone-like channels.
    // Index idx_channel_guardian_challenges_lookup is non-unique, no collision risk.
    normalizeColumnByChannel(
      "channel_guardian_verification_challenges",
      "expected_external_user_id",
      "channel",
    );
    normalizeColumnByChannel(
      "channel_guardian_verification_challenges",
      "consumed_by_external_user_id",
      "channel",
    );
    // expected_phone_e164 is always a phone number regardless of channel.
    // No unique index includes this column, no collision risk.
    normalizeColumnUnconditionally(
      "channel_guardian_verification_challenges",
      "expected_phone_e164",
    );

    // ── canonical_guardian_requests ───────────────────────────────
    // Has `source_channel` column — only normalize phone-like channels.
    // All indexes on this table are non-unique, no collision risk.
    normalizeColumnByChannel(
      "canonical_guardian_requests",
      "requester_external_user_id",
      "source_channel",
    );
    normalizeColumnByChannel(
      "canonical_guardian_requests",
      "guardian_external_user_id",
      "source_channel",
    );
    normalizeColumnByChannel(
      "canonical_guardian_requests",
      "decided_by_external_user_id",
      "source_channel",
    );

    // ── channel_guardian_rate_limits ──────────────────────────────
    // Has `channel` column — only normalize phone-like channels.
    // Unique index idx_channel_guardian_rate_limits_actor is on
    // (assistant_id, channel, actor_external_user_id, actor_chat_id) —
    // collision possible when two format variants normalize to the same E.164
    // within the same (assistant_id, channel, actor_chat_id) scope.
    normalizeColumnByChannel(
      "channel_guardian_rate_limits",
      "actor_external_user_id",
      "channel",
      {
        peerColumns: ["assistant_id", "channel", "actor_chat_id"],
      },
    );

    // Write checkpoint
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
