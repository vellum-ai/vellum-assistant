/**
 * One-time migration: backfill assistant-only ingress invites into the gateway
 * `ingress_invites` table so the gateway-native list/revoke/redeem paths work
 * for invites created before this migration (or via the assistant IPC/CLI
 * `invites_create` path, which only writes the assistant DB).
 *
 * This is a COPY/RECONCILE, not a move: the assistant `assistant_ingress_invites`
 * table remains the assistant-side store (voice UX fields etc.). We only INSERT
 * missing rows into the gateway table.
 *
 * Idempotent: uses INSERT OR IGNORE so gateway rows created post-migration are
 * never overwritten. Safe to re-run.
 *
 * FK safety: gateway `ingress_invites.contactId` is a NOT NULL FK to `contacts`
 * (ON DELETE CASCADE). Only rows whose contactId exists in the gateway
 * `contacts` table are inserted; rows with a missing/null contact are skipped
 * and counted so one bad row can't abort the whole backfill.
 */

import { Database } from "bun:sqlite";

import { getGatewayDb } from "../connection.js";
import { getLogger } from "../../logger.js";
import { assistantDbQuery } from "../assistant-db-proxy.js";

import type { MigrationResult } from "./index.js";

const log = getLogger("m0007-backfill-ingress-invites");

function getRawGatewayDb(): Database {
  return (getGatewayDb() as unknown as { $client: Database }).$client;
}

interface AssistantInviteRow {
  id: string;
  source_channel: string;
  invite_code_hash: string | null;
  voice_code_hash: string | null;
  token_hash: string | null;
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

    // ── 2. Read every assistant invite (active + terminal) ─────────────────
    // Copying terminal invites with their real status keeps the gateway list
    // history-complete; INSERT OR IGNORE keeps this idempotent.
    const rows = await assistantDbQuery<AssistantInviteRow>(
      `SELECT id, source_channel, invite_code_hash, voice_code_hash, token_hash,
              note, max_uses, use_count, expires_at, status,
              redeemed_by_external_user_id, redeemed_by_external_chat_id,
              redeemed_at, contact_id, created_at, updated_at
         FROM assistant_ingress_invites`,
    );

    if (rows.length === 0) {
      log.info("No assistant ingress invites to backfill");
      return "done";
    }

    // ── 3. Resolve which contacts exist in the gateway (FK safety) ─────────
    const gatewayContactIds = new Set(
      gwDb
        .prepare("SELECT id FROM contacts")
        .all()
        .map((r) => (r as { id: string }).id),
    );

    const insert = gwDb.prepare(
      `INSERT OR IGNORE INTO ingress_invites
         (id, source_channel, invite_code_hash, note, max_uses, use_count,
          expires_at, status, redeemed_by_external_user_id,
          redeemed_by_external_chat_id, redeemed_at, contact_id,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    let backfilled = 0;
    let skippedMissingContact = 0;
    let skippedNoCodeHash = 0;

    const txn = gwDb.transaction(() => {
      for (const row of rows) {
        // FK safety: skip rows whose contact is null or absent in gateway.
        if (!row.contact_id || !gatewayContactIds.has(row.contact_id)) {
          skippedMissingContact += 1;
          continue;
        }

        // inviteCodeHash is NOT NULL in the gateway. Token invites carry
        // invite_code_hash; voice invites carry voice_code_hash; older rows
        // may only have token_hash. Pick the first non-null.
        const inviteCodeHash =
          row.invite_code_hash ?? row.voice_code_hash ?? row.token_hash;
        if (inviteCodeHash == null) {
          skippedNoCodeHash += 1;
          continue;
        }

        insert.run(
          row.id,
          row.source_channel,
          inviteCodeHash,
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
        backfilled += 1;
      }
    });
    txn();

    log.info(
      {
        total: rows.length,
        backfilled,
        skippedMissingContact,
        skippedNoCodeHash,
      },
      "m0007: backfilled assistant ingress invites into gateway",
    );

    return "done";
  } catch (err) {
    log.error(
      { err },
      "m0007: ingress invite backfill failed — will retry on next startup",
    );
    return "skip";
  }
}

export function down(): MigrationResult {
  // No-op: backfilled rows are legitimate gateway data; never delete on rollback.
  return "done";
}
