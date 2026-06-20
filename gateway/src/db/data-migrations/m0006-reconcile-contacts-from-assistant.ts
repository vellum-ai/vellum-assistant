/**
 * One-time migration: reconcile contacts + contact_channels from the
 * assistant DB into the gateway DB for any rows that are missing.
 *
 * Context: the gateway became the ACL source of truth when `upsertContact`
 * gained its best-effort dual-write. But contacts created by other paths
 * (guardian-bootstrap raw SQL, invite redemption, pre-dual-write-era writes,
 * or any raw-SQL mutations that bypassed the gateway) may live only in the
 * assistant DB. Without this reconciliation, a gateway-native contact list
 * would silently drop those contacts — looking like data loss.
 *
 * This migration scans the assistant DB for contact IDs and channel IDs that
 * are absent from the gateway DB and seeds them. It copies ONLY ACL fields
 * (role, principalId, channel status/policy/verification). Informational
 * fields (notes, userFile, contactType, assistant_contact_metadata) are
 * intentionally NOT copied — they remain in the assistant DB per the ACL/info
 * split (see memory/concepts/decision/contact-data-split.md).
 *
 * Idempotent: uses INSERT OR IGNORE so existing gateway rows are never
 * overwritten. On a DB where all contacts are already in gateway, this is a
 * no-op. Safe to re-run.
 */

import { Database } from "bun:sqlite";

import { getGatewayDb } from "../connection.js";
import { getLogger } from "../../logger.js";
import { assistantDbQuery } from "../assistant-db-proxy.js";

import type { MigrationResult } from "./index.js";

const log = getLogger("m0006-reconcile-contacts");

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
  last_seen_at: number | null;
  interaction_count: number;
  last_interaction: number | null;
  created_at: number;
  updated_at: number | null;
}

export async function up(): Promise<MigrationResult> {
  const gwDb = getRawGatewayDb();

  // ── 1. Check that the assistant contacts table exists ──────────────────
  const hasContactsTable = await assistantDbQuery<{ "1": number }>(
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'contacts'`,
  );
  if (hasContactsTable.length === 0) {
    log.info("Assistant DB has no contacts table — nothing to reconcile");
    return "done";
  }

  // ── 2. Read all contacts from assistant DB ─────────────────────────────
  const assistantContacts = await assistantDbQuery<AssistantContactRow>(
    `SELECT id, display_name, role, principal_id, created_at, updated_at
       FROM contacts`,
  );

  // ── 3. Get existing contact IDs from gateway DB ────────────────────────
  const gatewayContactIds = new Set(
    gwDb
      .prepare("SELECT id FROM contacts")
      .all()
      .map((r) => (r as { id: string }).id),
  );

  // ── 4. Insert missing contacts into gateway ────────────────────────────
  const missingContacts = assistantContacts.filter(
    (c) => !gatewayContactIds.has(c.id),
  );

  let reconciledContacts = 0;
  if (missingContacts.length > 0) {
    const insertContact = gwDb.prepare(
      `INSERT OR IGNORE INTO contacts
         (id, display_name, role, principal_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const txn = gwDb.transaction(() => {
      for (const c of missingContacts) {
        insertContact.run(
          c.id,
          c.display_name,
          c.role,
          c.principal_id,
          c.created_at,
          c.updated_at,
        );
      }
    });
    txn();
    reconciledContacts = missingContacts.length;
    log.info(
      { count: reconciledContacts },
      "m0006: reconciled missing contacts from assistant DB into gateway",
    );
  } else {
    log.info("m0006: all assistant contacts already present in gateway");
  }

  // ── 5. Read all contact_channels from assistant DB ─────────────────────
  const hasChannelsTable = await assistantDbQuery<{ "1": number }>(
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'contact_channels'`,
  );

  let reconciledChannels = 0;
  if (hasChannelsTable.length > 0) {
    const assistantChannels = await assistantDbQuery<AssistantChannelRow>(
      `SELECT id, contact_id, type, address, is_primary, external_chat_id,
              status, policy, verified_at, verified_via, invite_id,
              revoked_reason, blocked_reason, last_seen_at,
              interaction_count, last_interaction, created_at, updated_at
         FROM contact_channels`,
    );

    // ── 6. Get existing channel IDs from gateway DB ──────────────────────
    const gatewayChannelIds = new Set(
      gwDb
        .prepare("SELECT id FROM contact_channels")
        .all()
        .map((r) => (r as { id: string }).id),
    );

    // ── 7. Insert missing channels into gateway ──────────────────────────
    // Only insert channels whose parent contact now exists in gateway
    // (either it was already there or we just reconciled it above).
    const missingChannels = assistantChannels.filter(
      (ch) =>
        !gatewayChannelIds.has(ch.id) &&
        // Parent contact must exist in gateway — if the assistant has an
        // orphaned channel with no matching contact, skip it rather than
        // create a FK violation.
        (gatewayContactIds.has(ch.contact_id) ||
          missingContacts.some((c) => c.id === ch.contact_id)),
    );

    if (missingChannels.length > 0) {
      const insertChannel = gwDb.prepare(
        `INSERT OR IGNORE INTO contact_channels
           (id, contact_id, type, address, is_primary, external_chat_id,
            status, policy, verified_at, verified_via, invite_id,
            revoked_reason, blocked_reason, last_seen_at,
            interaction_count, last_interaction, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const txn = gwDb.transaction(() => {
        for (const ch of missingChannels) {
          insertChannel.run(
            ch.id,
            ch.contact_id,
            ch.type,
            ch.address,
            ch.is_primary,
            ch.external_chat_id,
            ch.status,
            ch.policy,
            ch.verified_at,
            ch.verified_via,
            ch.invite_id,
            ch.revoked_reason,
            ch.blocked_reason,
            ch.last_seen_at,
            ch.interaction_count,
            ch.last_interaction,
            ch.created_at,
            ch.updated_at,
          );
        }
      });
      txn();
      reconciledChannels = missingChannels.length;
      log.info(
        { count: reconciledChannels },
        "m0006: reconciled missing contact_channels from assistant DB into gateway",
      );
    } else {
      log.info(
        "m0006: all assistant contact_channels already present in gateway",
      );
    }
  }

  log.info(
    { reconciledContacts, reconciledChannels },
    "m0006: reconciliation complete",
  );

  return "done";
}

export function down(): MigrationResult {
  // No-op: reconciled rows are legitimate ACL data that should remain in the
  // gateway. We never delete on rollback.
  log.info("m0006: down is a no-op (reconciled rows are legitimate)");
  return "skip";
}
