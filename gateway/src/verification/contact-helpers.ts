/**
 * Contact upsert/lookup helpers for gateway-owned verification.
 *
 * All operations go through assistantDbQuery/assistantDbRun (raw SQL via
 * IPC proxy). No IPC routes are used — only the direct SQL executor.
 *
 * These helpers cover the subset of contact operations needed by the
 * verification intercept flow. They are intentionally simpler than the
 * assistant's full upsertContact/syncChannels — we only need to upsert
 * a single contact+channel for the verifying user.
 */

import { eq } from "drizzle-orm";

import {
  assistantDbQuery,
  assistantDbRun,
} from "../db/assistant-db-proxy.js";
import { getGatewayDb } from "../db/connection.js";
import { contactChannels as gwContactChannels, contacts as gwContacts } from "../db/schema.js";
import { getLogger } from "../logger.js";
import { canonicalizeInboundIdentity } from "./identity.js";

const log = getLogger("verification-contacts");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContactChannelRow {
  channelId: string;
  contactId: string;
  externalUserId: string | null;
  externalChatId: string | null;
  displayName: string | null;
  status: string;
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/**
 * Find an existing contact channel for a given channel type + external user ID.
 */
export async function findContactChannelByExternalUserId(
  channelType: string,
  externalUserId: string,
): Promise<ContactChannelRow | null> {
  const rows = await assistantDbQuery<ContactChannelRow>(
    `SELECT cc.id AS channelId, cc.contact_id AS contactId,
            cc.external_user_id AS externalUserId,
            cc.external_chat_id AS externalChatId,
            c.display_name AS displayName,
            cc.status
     FROM contact_channels cc
     JOIN contacts c ON c.id = cc.contact_id
     WHERE cc.type = ? AND cc.external_user_id = ?
     LIMIT 1`,
    [channelType, externalUserId],
  );
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Upsert
// ---------------------------------------------------------------------------

/**
 * Upsert a contact + channel for a verified user.
 *
 * If a contact channel with the same (type, address) exists, updates it.
 * Otherwise creates a new contact + channel.
 *
 * This is intentionally simpler than the assistant's full upsertContact —
 * it handles the verification-specific case only (single channel, no
 * reassignment, no invite binding).
 */
export async function upsertVerifiedContactChannel(params: {
  sourceChannel: string;
  externalUserId: string;
  externalChatId: string;
  displayName?: string;
  username?: string;
}): Promise<void> {
  const now = Date.now();
  const { sourceChannel, externalChatId, displayName, username } = params;

  const canonicalUserId =
    canonicalizeInboundIdentity(sourceChannel, params.externalUserId) ??
    params.externalUserId;
  const address = canonicalUserId.toLowerCase();
  const contactDisplayName = displayName ?? username ?? canonicalUserId;

  // Check if a channel with this (type, address) already exists
  const existing = await assistantDbQuery<{
    channelId: string;
    contactId: string;
    channelStatus: string;
  }>(
    `SELECT cc.id AS channelId, cc.contact_id AS contactId, cc.status AS channelStatus
     FROM contact_channels cc
     WHERE cc.type = ? AND cc.address = ?
     LIMIT 1`,
    [sourceChannel, address],
  );

  if (existing.length > 0) {
    const row = existing[0];

    // Don't overwrite blocked channels
    if (row.channelStatus === "blocked") {
      log.warn({ sourceChannel, address }, "Skipping upsert: channel is blocked");
      return;
    }

    // Update existing channel
    await assistantDbRun(
      `UPDATE contact_channels
       SET status = 'active', policy = 'allow',
           external_user_id = ?, external_chat_id = ?,
           revoked_reason = NULL, blocked_reason = NULL,
           updated_at = ?
       WHERE id = ?`,
      [canonicalUserId, externalChatId, now, row.channelId],
    );

    // Dual-write to gateway DB
    try {
      const gwDb = getGatewayDb();
      gwDb.update(gwContactChannels)
        .set({
          status: "active",
          policy: "allow",
          externalUserId: canonicalUserId,
          externalChatId,
          revokedReason: null,
          blockedReason: null,
          updatedAt: now,
        })
        .where(eq(gwContactChannels.id, row.channelId))
        .run();
    } catch (gwErr) {
      log.warn({ err: gwErr }, "Gateway DB contact channel update dual-write failed");
    }

    return;
  }

  // Create new contact + channel. Both use OR IGNORE for idempotency under
  // retries. If the channel insert fails mid-flight, the orphan contact row
  // is harmless (no channels → invisible in UI, cleaned up by next upsert
  // for the same identity which will find-by-address and reuse it).
  const contactId = crypto.randomUUID();
  const channelId = crypto.randomUUID();

  await assistantDbRun(
    `INSERT OR IGNORE INTO contacts (id, display_name, role, created_at, updated_at)
     VALUES (?, ?, 'contact', ?, ?)`,
    [contactId, contactDisplayName, now, now],
  );

  await assistantDbRun(
    `INSERT OR IGNORE INTO contact_channels
       (id, contact_id, type, address, is_primary, external_user_id, external_chat_id,
        status, policy, interaction_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, ?, ?, 'active', 'allow', 0, ?, ?)`,
    [channelId, contactId, sourceChannel, address, canonicalUserId, externalChatId, now, now],
  );

  // Dual-write to gateway DB
  try {
    const gwDb = getGatewayDb();
    gwDb.insert(gwContacts)
      .values({
        id: contactId,
        displayName: contactDisplayName,
        role: "contact",
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .run();

    gwDb.insert(gwContactChannels)
      .values({
        id: channelId,
        contactId,
        type: sourceChannel,
        address,
        isPrimary: false,
        externalUserId: canonicalUserId,
        externalChatId,
        status: "active",
        policy: "allow",
        interactionCount: 0,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .run();
  } catch (gwErr) {
    log.warn({ err: gwErr }, "Gateway DB contact create dual-write failed");
  }
}
