/**
 * One-time migration: UPSERT the ACL columns from the assistant DB onto the
 * gateway DB. Inserts contacts/contact_channels that exist only in the assistant
 * DB, and updates the ACL columns (role, principalId; channel status, policy,
 * verification, revoked/blocked reasons) on rows that already exist in the
 * gateway.
 *
 * Channels match existing gateway rows on the case-insensitive logical key
 * (type, lower(address)): the gateway UNIQUE(type, address) index is
 * case-sensitive but lookups collate NOCASE, so matching on lower(address)
 * updates the existing row in place instead of inserting a duplicate for the
 * same actor. Gateway-first mints its own channel ids, so the same channel can
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
import { assistantHasContactAclColumns } from "./assistant-contact-acl-columns.js";
import { assistantInviteIdSelect } from "./assistant-invite-id-column.js";

import type { MigrationResult } from "./index.js";

const log = getLogger("m0008-upsert-acl-columns");

function getRawGatewayDb(): Database {
  return (getGatewayDb() as unknown as { $client: Database }).$client;
}

/**
 * The escalate policy is removed. This backfill can re-run after
 * m0017-coerce-escalate-policy has checkpointed, so coerce on import to keep
 * escalate out of the gateway regardless of ordering (deny = fail-closed).
 */
function importedPolicy(policy: string): string {
  return policy === "escalate" ? "deny" : policy;
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

    // Terminal, unlike the absent table above: checkpoint, don't retry.
    if (!(await assistantHasContactAclColumns())) {
      log.info("Assistant DB has no contact ACL columns — nothing to backfill");
      return "done";
    }

    // ── 2. Read the assistant ACL source rows ──────────────────────────────
    const assistantContacts = await assistantDbQuery<AssistantContactRow>(
      `SELECT id, display_name, role, principal_id, created_at, updated_at
         FROM contacts`,
    );
    const assistantChannels = await assistantDbQuery<AssistantChannelRow>(
      `SELECT id, contact_id, type, address, is_primary, external_chat_id,
              status, policy, verified_at, verified_via,
              ${await assistantInviteIdSelect()},
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

    // ── 4. Upsert channels by the case-insensitive (type, lower(address)) key ─
    // The gateway UNIQUE(type, address) index is case-sensitive, but the logical
    // channel key and COLLATE NOCASE lookups treat address case-insensitively.
    // Match existing gateway rows on lower(address) and UPDATE their ACL in
    // place; INSERT only genuinely-new channels so a case-variant address never
    // forks a second row for the same actor. The update also converges
    // contact_id onto the assistant contact that carries the imported
    // role/principal_id, so a split channel (parented to a different gateway
    // contact) joins back to the contact whose ACL we just backfilled. Skip any
    // channel whose parent contact is not among the assistant contacts we just
    // upserted (FK safety).
    const contactIds = new Set(assistantContacts.map((c) => c.id));

    const channelKey = (type: string, address: string): string =>
      `${type}|${address.toLowerCase()}`;

    const existingChannelIdByKey = new Map<string, string>();
    for (const row of gwDb
      .prepare(`SELECT id, type, address FROM contact_channels`)
      .all() as { id: string; type: string; address: string }[]) {
      existingChannelIdByKey.set(channelKey(row.type, row.address), row.id);
    }

    const updateChannelAcl = gwDb.prepare(
      `UPDATE contact_channels SET
         contact_id = ?,
         status = ?, policy = ?, verified_at = ?, verified_via = ?,
         revoked_reason = ?, blocked_reason = ?
       WHERE id = ?`,
    );
    const insertChannel = gwDb.prepare(
      `INSERT INTO contact_channels
         (id, contact_id, type, address, is_primary, external_chat_id,
          status, policy, verified_at, verified_via, invite_id,
          revoked_reason, blocked_reason, last_seen_at,
          interaction_count, last_interaction, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, NULL, ?, ?)`,
    );

    let upsertedChannels = 0;
    let skippedOrphans = 0;
    const channelsTxn = gwDb.transaction(() => {
      for (const ch of assistantChannels) {
        if (!contactIds.has(ch.contact_id)) {
          skippedOrphans += 1;
          continue;
        }
        const key = channelKey(ch.type, ch.address);
        const existingId = existingChannelIdByKey.get(key);
        if (existingId) {
          updateChannelAcl.run(
            ch.contact_id,
            ch.status,
            importedPolicy(ch.policy),
            ch.verified_at,
            ch.verified_via,
            ch.revoked_reason,
            ch.blocked_reason,
            existingId,
          );
        } else {
          insertChannel.run(
            ch.id,
            ch.contact_id,
            ch.type,
            ch.address,
            ch.is_primary ? 1 : 0,
            ch.external_chat_id,
            ch.status,
            importedPolicy(ch.policy),
            ch.verified_at,
            ch.verified_via,
            ch.invite_id,
            ch.revoked_reason,
            ch.blocked_reason,
            ch.created_at,
            ch.updated_at,
          );
          // Track the inserted row so a later case-variant updates it in place.
          existingChannelIdByKey.set(key, ch.id);
        }
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
