/**
 * One-time migration: full-field backfill of assistant ingress invites into
 * the gateway `ingress_invites` table, covering the columns added after the
 * m0007 backfill (token_hash, voice_code_hash, voice_code_digits,
 * expected_external_user_id, friend_name, guardian_name,
 * source_conversation_id).
 *
 * Also corrects `invite_code_hash`: m0007 collapsed
 * `invite_code_hash ?? voice_code_hash ?? token_hash` into the gateway's
 * single hash column. This migration restores the assistant row's true
 * `invite_code_hash`, writing the NO_INVITE_CODE_HASH ("") sentinel when the
 * assistant value is NULL — the gateway column stays NOT NULL (relaxing it
 * requires a drizzle-push table rebuild that corrupts existing DBs; see the
 * schema.ts comment).
 *
 * Rows already in the gateway are UPDATEd (new columns + hash correction
 * only — lifecycle columns are gateway truth). Rows absent gateway-side are
 * INSERTed with the full field set. A2A invites live in the assistant's
 * dedicated `a2a_invites` flow and are excluded.
 *
 * Idempotent: UPDATE writes the same values on re-run; INSERT OR IGNORE never
 * duplicates. FK safety: inserts skip rows whose contact_id is missing from
 * gateway `contacts` (same as m0007).
 */

import { Database } from "bun:sqlite";

import { getGatewayDb } from "../connection.js";
import { getLogger } from "../../logger.js";
import { assistantDbQuery } from "../assistant-db-proxy.js";
import { NO_INVITE_CODE_HASH } from "../contact-store.js";

import type { MigrationResult } from "./index.js";

const log = getLogger("m0009-invite-fields-backfill");

function getRawGatewayDb(): Database {
  return (getGatewayDb() as unknown as { $client: Database }).$client;
}

interface AssistantInviteRow {
  id: string;
  source_channel: string;
  invite_code_hash: string | null;
  token_hash: string | null;
  voice_code_hash: string | null;
  voice_code_digits: number | null;
  expected_external_user_id: string | null;
  friend_name: string | null;
  guardian_name: string | null;
  source_conversation_id: string | null;
  note: string | null;
  max_uses: number;
  use_count: number;
  expires_at: number;
  status: string;
  redeemed_by_external_user_id: string | null;
  redeemed_by_external_chat_id: string | null;
  redeemed_at: number | null;
  contact_id: string | null;
  created_at: number;
  updated_at: number;
}

export async function up(): Promise<MigrationResult> {
  const gwDb = getRawGatewayDb();

  try {
    // ── 1. Bail if the assistant table doesn't exist (fresh install) ───────
    const hasTable = await assistantDbQuery<{ "1": number }>(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'assistant_ingress_invites'`,
    );
    if (hasTable.length === 0) {
      log.info(
        "Assistant DB has no assistant_ingress_invites table — nothing to backfill",
      );
      return "done";
    }

    // ── 2. Read every non-a2a assistant invite ──────────────────────────────
    const rows = await assistantDbQuery<AssistantInviteRow>(
      `SELECT id, source_channel, invite_code_hash, token_hash, voice_code_hash,
              voice_code_digits, expected_external_user_id, friend_name,
              guardian_name, source_conversation_id, note, max_uses, use_count,
              expires_at, status, redeemed_by_external_user_id,
              redeemed_by_external_chat_id, redeemed_at, contact_id,
              created_at, updated_at
         FROM assistant_ingress_invites
        WHERE source_channel != 'a2a'`,
    );

    if (rows.length === 0) {
      log.info("No assistant ingress invites to backfill");
      return "done";
    }

    // ── 3. Resolve existing gateway invites + contacts (FK safety) ─────────
    const gatewayInviteIds = new Set(
      gwDb
        .prepare("SELECT id FROM ingress_invites")
        .all()
        .map((r) => (r as { id: string }).id),
    );
    const gatewayContactIds = new Set(
      gwDb
        .prepare("SELECT id FROM contacts")
        .all()
        .map((r) => (r as { id: string }).id),
    );

    // Only the widened columns + the hash correction — lifecycle columns
    // (status, use_count, redeemed_*) are gateway truth and never touched.
    const update = gwDb.prepare(
      `UPDATE ingress_invites
          SET invite_code_hash = ?, token_hash = ?, voice_code_hash = ?,
              voice_code_digits = ?, expected_external_user_id = ?,
              friend_name = ?, guardian_name = ?, source_conversation_id = ?
        WHERE id = ?`,
    );

    const insert = gwDb.prepare(
      `INSERT OR IGNORE INTO ingress_invites
         (id, source_channel, invite_code_hash, token_hash, voice_code_hash,
          voice_code_digits, expected_external_user_id, friend_name,
          guardian_name, source_conversation_id, note, max_uses, use_count,
          expires_at, status, redeemed_by_external_user_id,
          redeemed_by_external_chat_id, redeemed_at, contact_id,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    let updated = 0;
    let inserted = 0;
    let skippedMissingContact = 0;

    const txn = gwDb.transaction(() => {
      for (const row of rows) {
        const inviteCodeHash = row.invite_code_hash ?? NO_INVITE_CODE_HASH;

        if (gatewayInviteIds.has(row.id)) {
          update.run(
            inviteCodeHash,
            row.token_hash,
            row.voice_code_hash,
            row.voice_code_digits,
            row.expected_external_user_id,
            row.friend_name,
            row.guardian_name,
            row.source_conversation_id,
            row.id,
          );
          updated += 1;
          continue;
        }

        // FK safety: skip inserts whose contact is null or absent in gateway.
        if (!row.contact_id || !gatewayContactIds.has(row.contact_id)) {
          skippedMissingContact += 1;
          continue;
        }

        insert.run(
          row.id,
          row.source_channel,
          inviteCodeHash,
          row.token_hash,
          row.voice_code_hash,
          row.voice_code_digits,
          row.expected_external_user_id,
          row.friend_name,
          row.guardian_name,
          row.source_conversation_id,
          row.note,
          row.max_uses,
          row.use_count,
          row.expires_at,
          row.status,
          row.redeemed_by_external_user_id,
          row.redeemed_by_external_chat_id,
          row.redeemed_at,
          row.contact_id,
          row.created_at,
          row.updated_at,
        );
        inserted += 1;
      }
    });
    txn();

    log.info(
      { total: rows.length, updated, inserted, skippedMissingContact },
      "m0009: backfilled full invite fields into gateway",
    );

    return "done";
  } catch (err) {
    log.error(
      { err },
      "m0009: invite fields backfill failed — will retry on next startup",
    );
    return "skip";
  }
}

export function down(): MigrationResult {
  // No-op: backfilled fields are legitimate gateway data; never delete on rollback.
  return "done";
}
