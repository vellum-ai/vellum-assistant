/**
 * One-time migration: backfill channel verification sessions + guardian
 * rate limits from the assistant DB into the gateway-owned tables.
 *
 * Sessions: the gateway `channel_verification_sessions` table starts
 * genuinely empty (m0011's retired mirror never had inserts), so this is a
 * straight copy — `INSERT OR IGNORE` by id gives idempotency on retry and
 * keeps in-flight sessions alive across an upgrade boot. One exception: if
 * the gateway already holds an interceptable non-expired session for a
 * channel (minted post-upgrade, before this migration ran — its
 * revoke-prior pass could not see the assistant rows), an interceptable
 * non-expired assistant row for that channel backfills as `revoked` so the
 * "only the latest session is valid" invariant holds. Terminal-status and
 * expired rows copy as-is (pure history).
 *
 * Rate limits: the gateway `channel_guardian_rate_limits` copy is already
 * primary, so assistant rows are inserted only where no gateway row exists —
 * `INSERT OR IGNORE` lets the gateway win conflicts on both the id PK and
 * the unique (channel, actor_external_user_id, actor_chat_id) index.
 *
 * Copy, not move: never writes to the assistant DB (m0013 does the drop,
 * gated on this migration's checkpoint). Returns "done" when the assistant
 * source table is already gone; any failure returns "skip" to retry on the
 * next startup.
 */

import { Database } from "bun:sqlite";

import { getGatewayDb } from "../connection.js";
import { getLogger } from "../../logger.js";
import { assistantDbQuery } from "../assistant-db-proxy.js";

import type { MigrationResult } from "./index.js";

const log = getLogger("m0012-verification-sessions-backfill");

// Mirrors INTERCEPTABLE_STATUSES in session-store.ts (migrations stay self-contained).
const INTERCEPTABLE_STATUSES = [
  "pending",
  "pending_bootstrap",
  "awaiting_response",
];

function getRawGatewayDb(): Database {
  return (getGatewayDb() as unknown as { $client: Database }).$client;
}

interface AssistantSessionRow {
  id: string;
  channel: string;
  challenge_hash: string;
  expires_at: number;
  status: string;
  source_conversation_id: string | null;
  consumed_by_external_user_id: string | null;
  consumed_by_chat_id: string | null;
  expected_external_user_id: string | null;
  expected_chat_id: string | null;
  expected_phone_e164: string | null;
  identity_binding_status: string | null;
  destination_address: string | null;
  last_sent_at: number | null;
  send_count: number | null;
  next_resend_at: number | null;
  code_digits: number | null;
  max_attempts: number | null;
  verification_purpose: string | null;
  bootstrap_token_hash: string | null;
  created_at: number;
  updated_at: number;
}

interface AssistantRateLimitRow {
  id: string;
  channel: string;
  actor_external_user_id: string;
  actor_chat_id: string;
  attempt_timestamps_json: string;
  locked_until: number | null;
  created_at: number;
  updated_at: number;
}

async function assistantTableExists(name: string): Promise<boolean> {
  const rows = await assistantDbQuery<{ "1": number }>(
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`,
    [name],
  );
  return rows.length > 0;
}

export async function up(): Promise<MigrationResult> {
  const gwDb = getRawGatewayDb();

  try {
    // ── 1. Bail if the assistant table is already gone (dropped/fresh) ─────
    if (!(await assistantTableExists("channel_verification_sessions"))) {
      log.info(
        "Assistant DB has no channel_verification_sessions table — nothing to backfill",
      );
      return "done";
    }

    // ── 2. Read the assistant rows ──────────────────────────────────────────
    const sessionRows = await assistantDbQuery<AssistantSessionRow>(
      `SELECT id, channel, challenge_hash, expires_at, status,
              source_conversation_id, consumed_by_external_user_id,
              consumed_by_chat_id, expected_external_user_id, expected_chat_id,
              expected_phone_e164, identity_binding_status,
              destination_address, last_sent_at, send_count, next_resend_at,
              code_digits, max_attempts, verification_purpose,
              bootstrap_token_hash, created_at, updated_at
         FROM channel_verification_sessions`,
    );

    const rateLimitRows = (await assistantTableExists(
      "channel_guardian_rate_limits",
    ))
      ? await assistantDbQuery<AssistantRateLimitRow>(
          `SELECT id, channel, actor_external_user_id, actor_chat_id,
                  attempt_timestamps_json, locked_until, created_at, updated_at
             FROM channel_guardian_rate_limits`,
        )
      : [];

    // ── 3. Copy into the gateway (OR IGNORE: gateway rows always win) ──────
    const insertSession = gwDb.prepare(
      `INSERT OR IGNORE INTO channel_verification_sessions
         (id, channel, challenge_hash, expires_at, status,
          source_conversation_id, consumed_by_external_user_id,
          consumed_by_chat_id, expected_external_user_id, expected_chat_id,
          expected_phone_e164, identity_binding_status, destination_address,
          last_sent_at, send_count, next_resend_at, code_digits, max_attempts,
          verification_purpose, bootstrap_token_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const insertRateLimit = gwDb.prepare(
      `INSERT OR IGNORE INTO channel_guardian_rate_limits
         (id, channel, actor_external_user_id, actor_chat_id,
          attempt_timestamps_json, locked_until, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    let sessionsInserted = 0;
    let sessionsRevoked = 0;
    let rateLimitsInserted = 0;

    const txn = gwDb.transaction(() => {
      // Snapshot channels holding a fresher (post-upgrade) gateway session
      // before inserting, so backfilled rows never shadow one another.
      const now = Date.now();
      const supersededChannels = new Set(
        (
          gwDb
            .prepare(
              `SELECT DISTINCT channel FROM channel_verification_sessions
                WHERE status IN ('pending', 'pending_bootstrap', 'awaiting_response')
                  AND expires_at > ?`,
            )
            .all(now) as { channel: string }[]
        ).map((r) => r.channel),
      );

      for (const row of sessionRows) {
        const superseded =
          INTERCEPTABLE_STATUSES.includes(row.status) &&
          row.expires_at > now &&
          supersededChannels.has(row.channel);

        const changes = insertSession.run(
          row.id,
          row.channel,
          row.challenge_hash,
          row.expires_at,
          superseded ? "revoked" : row.status,
          row.source_conversation_id,
          row.consumed_by_external_user_id,
          row.consumed_by_chat_id,
          row.expected_external_user_id,
          row.expected_chat_id,
          row.expected_phone_e164,
          row.identity_binding_status,
          row.destination_address,
          row.last_sent_at,
          row.send_count,
          row.next_resend_at,
          row.code_digits,
          row.max_attempts,
          row.verification_purpose,
          row.bootstrap_token_hash,
          row.created_at,
          row.updated_at,
        ).changes;
        sessionsInserted += changes;
        if (superseded && changes > 0) sessionsRevoked += 1;
      }

      for (const row of rateLimitRows) {
        rateLimitsInserted += insertRateLimit.run(
          row.id,
          row.channel,
          row.actor_external_user_id,
          row.actor_chat_id,
          row.attempt_timestamps_json,
          row.locked_until,
          row.created_at,
          row.updated_at,
        ).changes;
      }
    });
    txn();

    log.info(
      {
        sessions: sessionRows.length,
        sessionsInserted,
        sessionsRevoked,
        rateLimits: rateLimitRows.length,
        rateLimitsInserted,
      },
      "m0012: backfilled verification sessions + guardian rate limits into gateway",
    );

    return "done";
  } catch (err) {
    log.error(
      { err },
      "m0012: verification sessions backfill failed — will retry on next startup",
    );
    return "skip";
  }
}

export function down(): MigrationResult {
  // No-op: backfilled rows are legitimate gateway data; never delete on rollback.
  return "done";
}
