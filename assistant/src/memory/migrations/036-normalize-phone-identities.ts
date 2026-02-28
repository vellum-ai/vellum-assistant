import { normalizePhoneNumber } from '../../util/phone.js';
import { type DrizzleDb, getSqliteFrom } from '../db-connection.js';

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
 * Idempotent: already-normalized values pass through normalizePhoneNumber
 * unchanged, and the checkpoint key prevents re-execution.
 */
export function migrateNormalizePhoneIdentities(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  const checkpointKey = 'migration_normalize_phone_identities_v1';
  const checkpoint = raw.query(
    `SELECT 1 FROM memory_checkpoints WHERE key = ?`,
  ).get(checkpointKey);
  if (checkpoint) return;

  const PHONE_CHANNELS = ['sms', 'voice', 'whatsapp'];

  // Helper: normalize a column's phone-like values in a table filtered by channel.
  // Returns the number of rows updated.
  function normalizeColumnByChannel(
    table: string,
    column: string,
    channelColumn: string,
  ): void {
    const tableExists = raw.query(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`,
    ).get(table);
    if (!tableExists) return;

    const colExists = raw.query(
      `SELECT 1 FROM pragma_table_info(?) WHERE name = ?`,
    ).get(table, column);
    if (!colExists) return;

    const chanColExists = raw.query(
      `SELECT 1 FROM pragma_table_info(?) WHERE name = ?`,
    ).get(table, channelColumn);
    if (!chanColExists) return;

    const rows = raw.query(
      `SELECT id, ${column} FROM ${table} WHERE ${channelColumn} IN (${PHONE_CHANNELS.map(() => '?').join(',')}) AND ${column} IS NOT NULL`,
    ).all(...PHONE_CHANNELS) as Array<{ id: string; [key: string]: string }>;

    if (rows.length === 0) return;

    const update = raw.prepare(
      `UPDATE ${table} SET ${column} = ? WHERE id = ?`,
    );

    for (const row of rows) {
      const original = row[column];
      if (!original) continue;
      const normalized = normalizePhoneNumber(original);
      if (normalized && normalized !== original) {
        update.run(normalized, row.id);
      }
    }
  }

  // Helper: normalize a column unconditionally (no channel filter).
  // Used for columns that are always phone numbers (e.g., expected_phone_e164).
  function normalizeColumnUnconditionally(
    table: string,
    column: string,
  ): void {
    const tableExists = raw.query(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`,
    ).get(table);
    if (!tableExists) return;

    const colExists = raw.query(
      `SELECT 1 FROM pragma_table_info(?) WHERE name = ?`,
    ).get(table, column);
    if (!colExists) return;

    const rows = raw.query(
      `SELECT id, ${column} FROM ${table} WHERE ${column} IS NOT NULL`,
    ).all() as Array<{ id: string; [key: string]: string }>;

    if (rows.length === 0) return;

    const update = raw.prepare(
      `UPDATE ${table} SET ${column} = ? WHERE id = ?`,
    );

    for (const row of rows) {
      const original = row[column];
      if (!original) continue;
      const normalized = normalizePhoneNumber(original);
      if (normalized && normalized !== original) {
        update.run(normalized, row.id);
      }
    }
  }

  try {
    raw.exec('BEGIN');

    // ── channel_guardian_bindings ──────────────────────────────────
    // Has `channel` column — only normalize phone-like channels.
    normalizeColumnByChannel(
      'channel_guardian_bindings',
      'guardian_external_user_id',
      'channel',
    );

    // ── assistant_ingress_members ─────────────────────────────────
    // Has `source_channel` column — only normalize phone-like channels.
    normalizeColumnByChannel(
      'assistant_ingress_members',
      'external_user_id',
      'source_channel',
    );

    // ── channel_guardian_verification_challenges ──────────────────
    // Has `channel` column — normalize identity columns for phone-like channels.
    normalizeColumnByChannel(
      'channel_guardian_verification_challenges',
      'expected_external_user_id',
      'channel',
    );
    normalizeColumnByChannel(
      'channel_guardian_verification_challenges',
      'consumed_by_external_user_id',
      'channel',
    );
    // expected_phone_e164 is always a phone number regardless of channel.
    normalizeColumnUnconditionally(
      'channel_guardian_verification_challenges',
      'expected_phone_e164',
    );

    // ── canonical_guardian_requests ───────────────────────────────
    // Has `source_channel` column — only normalize phone-like channels.
    normalizeColumnByChannel(
      'canonical_guardian_requests',
      'requester_external_user_id',
      'source_channel',
    );
    normalizeColumnByChannel(
      'canonical_guardian_requests',
      'guardian_external_user_id',
      'source_channel',
    );
    normalizeColumnByChannel(
      'canonical_guardian_requests',
      'decided_by_external_user_id',
      'source_channel',
    );

    // ── channel_guardian_rate_limits ──────────────────────────────
    // Has `channel` column — only normalize phone-like channels.
    normalizeColumnByChannel(
      'channel_guardian_rate_limits',
      'actor_external_user_id',
      'channel',
    );

    // Write checkpoint
    raw.query(
      `INSERT OR IGNORE INTO memory_checkpoints (key, value, updated_at) VALUES (?, '1', ?)`,
    ).run(checkpointKey, Date.now());

    raw.exec('COMMIT');
  } catch (e) {
    try { raw.exec('ROLLBACK'); } catch { /* no active transaction */ }
    throw e;
  }
}
