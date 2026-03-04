import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

/**
 * Safety-sync remaining legacy data to contacts, then drop the legacy
 * `assistant_ingress_members` and `channel_guardian_bindings` tables.
 *
 * All production reads/writes now go through the contacts table. This
 * migration ensures any stragglers are synced, then removes the legacy
 * tables so they stop accumulating dead weight.
 *
 * Idempotent: checks for table existence before syncing/dropping.
 */
export function migrateDropLegacyMemberGuardianTables(
  database: DrizzleDb,
): void {
  const raw = getSqliteFrom(database);

  // ── Safety sync: guardian bindings → contacts ─────────────────────
  const guardianTableExists = raw
    .prepare(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'channel_guardian_bindings'`,
    )
    .get();

  if (guardianTableExists) {
    // Insert any active guardian bindings not already present in contacts.
    // We match on (type, external_user_id) to avoid duplicating existing rows.
    raw.exec(/*sql*/ `
      INSERT INTO contacts (id, display_name, role, principal_id, created_at)
      SELECT
        'legacy-guardian-' || b.id,
        COALESCE(
          json_extract(b.metadata_json, '$.displayName'),
          b.guardian_external_user_id
        ),
        'guardian',
        b.guardian_principal_id,
        b.created_at
      FROM channel_guardian_bindings b
      WHERE b.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM contact_channels cc
          WHERE cc.type = b.channel
            AND cc.external_user_id = b.guardian_external_user_id
        )
    `);

    raw.exec(/*sql*/ `
      INSERT INTO contact_channels (id, contact_id, type, address, external_user_id, external_chat_id, status, verified_at, verified_via, created_at)
      SELECT
        'legacy-gc-' || b.id,
        'legacy-guardian-' || b.id,
        b.channel,
        b.guardian_external_user_id,
        b.guardian_external_user_id,
        b.guardian_delivery_chat_id,
        'active',
        b.verified_at,
        b.verified_via,
        b.created_at
      FROM channel_guardian_bindings b
      WHERE b.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM contact_channels cc
          WHERE cc.type = b.channel
            AND cc.external_user_id = b.guardian_external_user_id
        )
    `);
  }

  // ── Safety sync: ingress members → contacts ───────────────────────
  const membersTableExists = raw
    .prepare(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'assistant_ingress_members'`,
    )
    .get();

  if (membersTableExists) {
    // Insert non-pending members not already present in contacts.
    raw.exec(/*sql*/ `
      INSERT INTO contacts (id, display_name, created_at)
      SELECT
        'legacy-member-' || m.id,
        COALESCE(m.display_name, m.username, m.external_user_id, 'Unknown'),
        m.created_at
      FROM assistant_ingress_members m
      WHERE m.status != 'pending'
        AND NOT EXISTS (
          SELECT 1 FROM contact_channels cc
          WHERE cc.type = m.source_channel
            AND (
              (m.external_user_id IS NOT NULL AND cc.external_user_id = m.external_user_id)
              OR (m.external_user_id IS NULL AND m.external_chat_id IS NOT NULL AND cc.external_chat_id = m.external_chat_id)
            )
        )
    `);

    raw.exec(/*sql*/ `
      INSERT INTO contact_channels (id, contact_id, type, address, external_user_id, external_chat_id, status, policy, invite_id, revoked_reason, blocked_reason, last_seen_at, created_at, updated_at)
      SELECT
        'legacy-mc-' || m.id,
        'legacy-member-' || m.id,
        m.source_channel,
        COALESCE(m.external_user_id, m.external_chat_id),
        m.external_user_id,
        m.external_chat_id,
        m.status,
        m.policy,
        m.invite_id,
        m.revoked_reason,
        m.blocked_reason,
        m.last_seen_at,
        m.created_at,
        m.updated_at
      FROM assistant_ingress_members m
      WHERE m.status != 'pending'
        AND NOT EXISTS (
          SELECT 1 FROM contact_channels cc
          WHERE cc.type = m.source_channel
            AND (
              (m.external_user_id IS NOT NULL AND cc.external_user_id = m.external_user_id)
              OR (m.external_user_id IS NULL AND m.external_chat_id IS NOT NULL AND cc.external_chat_id = m.external_chat_id)
            )
        )
    `);
  }

  // ── Drop legacy tables ────────────────────────────────────────────
  raw.exec(/*sql*/ `DROP TABLE IF EXISTS assistant_ingress_members`);
  raw.exec(/*sql*/ `DROP TABLE IF EXISTS channel_guardian_bindings`);
}
