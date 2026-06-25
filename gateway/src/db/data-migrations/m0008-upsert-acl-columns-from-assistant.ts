/**
 * One-time migration: UPSERT the ACL columns from the assistant DB onto the
 * gateway DB. Inserts contacts/contact_channels that exist only in the assistant
 * DB, and updates the ACL columns (role, principalId; channel status, policy,
 * verification, revoked/blocked reasons) on rows that already exist in the
 * gateway.
 *
 * Channels are keyed on the logical (type, address) — the gateway has a UNIQUE
 * index there — because gateway-first mints its own ids, so the same channel can
 * carry different ids across the two DBs.
 *
 * Never overwrites display_name, timestamps, or the gateway-owned INFO/telemetry
 * columns (is_primary, last_seen_at, interaction_count, last_interaction).
 *
 * "skip" on an unreachable assistant DB so the runner retries on next boot.
 */

import { Database } from "bun:sqlite";

import { getGatewayDb } from "../connection.js";
import { getLogger } from "../../logger.js";
import { assistantDbQuery } from "../assistant-db-proxy.js";

import type { MigrationResult } from "./index.js";

const log = getLogger("m0008-upsert-acl-columns");

function getRawGatewayDb(): Database {
  return (getGatewayDb() as unknown as { $client: Database }).$client;
}

interface AssistantContactRow {
  id: string;
  display_name: string;
  role: string;
  principal_id: string | null;
  created_at: number;
  updated_at: number;
}

interface AssistantChannelRow {
  id: string;
  contact_id: string;
  type: string;
  address: string;
  is_primary: number;
  external_chat_id: string | null;
  status: string;
  policy: string;
  verified_at: number | null;
  verified_via: string | null;
  invite_id: string | null;
  revoked_reason: string | null;
  blocked_reason: string | null;
  created_at: number;
  updated_at: number | null;
}

export async function up(): Promise<MigrationResult> {
  const gwDb = getRawGatewayDb();

  try {
    // ── 1. Bail if the assistant tables don't exist (fresh install) ────────
    const hasContactsTable = await assistantDbQuery<{ "1": number }>(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'contacts'`,
    );
    const hasChannelsTable = await assistantDbQuery<{ "1": number }>(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'contact_channels'`,
    );
    if (hasContactsTable.length === 0 || hasChannelsTable.length === 0) {
      log.info(
        "Assistant DB missing contacts/contact_channels — retrying next boot",
      );
      return "skip";
    }

    // ── 2. Read the assistant ACL source rows ──────────────────────────────
    const assistantContacts = await assistantDbQuery<AssistantContactRow>(
      `SELECT id, display_name, role, principal_id, created_at, updated_at
         FROM contacts`,
    );
    const assistantChannels = await assistantDbQuery<AssistantChannelRow>(
      `SELECT id, contact_id, type, address, is_primary, external_chat_id,
              status, policy, verified_at, verified_via, invite_id,
              revoked_reason, blocked_reason, created_at, updated_at
         FROM contact_channels`,
    );

    // ── 3. Upsert contacts (insert missing, update ACL on conflict) ────────
    const upsertContact = gwDb.prepare(
      `INSERT INTO contacts
         (id, display_name, role, principal_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         role = excluded.role,
         principal_id = excluded.principal_id`,
    );
    const contactsTxn = gwDb.transaction(() => {
      for (const c of assistantContacts) {
        upsertContact.run(
          c.id,
          c.display_name,
          c.role,
          c.principal_id,
          c.created_at,
          c.updated_at,
        );
      }
    });
    contactsTxn();

    // ── 4. Upsert channels keyed on (type, address) ────────────────────────
    // Skip any channel whose parent contact is not among the assistant
    // contacts we just upserted, to avoid an FK violation.
    const contactIds = new Set(assistantContacts.map((c) => c.id));

    const upsertChannel = gwDb.prepare(
      `INSERT INTO contact_channels
         (id, contact_id, type, address, is_primary, external_chat_id,
          status, policy, verified_at, verified_via, invite_id,
          revoked_reason, blocked_reason, last_seen_at,
          interaction_count, last_interaction, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, NULL, ?, ?)
       ON CONFLICT(type, address) DO UPDATE SET
         status = excluded.status,
         policy = excluded.policy,
         verified_at = excluded.verified_at,
         verified_via = excluded.verified_via,
         revoked_reason = excluded.revoked_reason,
         blocked_reason = excluded.blocked_reason`,
    );

    let upsertedChannels = 0;
    let skippedOrphans = 0;
    const channelsTxn = gwDb.transaction(() => {
      for (const ch of assistantChannels) {
        if (!contactIds.has(ch.contact_id)) {
          skippedOrphans += 1;
          continue;
        }
        upsertChannel.run(
          ch.id,
          ch.contact_id,
          ch.type,
          ch.address,
          ch.is_primary ? 1 : 0,
          ch.external_chat_id,
          ch.status,
          ch.policy,
          ch.verified_at,
          ch.verified_via,
          ch.invite_id,
          ch.revoked_reason,
          ch.blocked_reason,
          ch.created_at,
          ch.updated_at,
        );
        upsertedChannels += 1;
      }
    });
    channelsTxn();

    log.info(
      {
        upsertedContacts: assistantContacts.length,
        upsertedChannels,
        skippedOrphans,
      },
      "m0008: upserted ACL columns from assistant DB into gateway",
    );

    return "done";
  } catch (err) {
    log.error(
      { err },
      "m0008: ACL backfill failed — will retry on next startup",
    );
    return "skip";
  }
}

export function down(): MigrationResult {
  // No-op: ACL in the gateway DB is legitimate data; never roll back.
  return "skip";
}
