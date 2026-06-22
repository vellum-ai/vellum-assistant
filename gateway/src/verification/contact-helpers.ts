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

import { existsSync } from "node:fs";

import { and, eq, sql } from "drizzle-orm";

import { assistantDbQuery, assistantDbRun } from "../db/assistant-db-proxy.js";
import { getGatewayDb } from "../db/connection.js";
import {
  contactChannels as gwContactChannels,
  contacts as gwContacts,
} from "../db/schema.js";
import { getLogger } from "../logger.js";
import { resolveIpcSocketPath } from "../ipc/socket-path.js";
import { canonicalizeInboundIdentity } from "./identity.js";

const log = getLogger("verification-contacts");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContactChannelRow {
  channelId: string;
  contactId: string;
  address: string;
  externalChatId: string | null;
  displayName: string | null;
  status: string;
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/**
 * Find an existing contact channel by (type, address).
 */
export async function findContactChannelByAddress(
  channelType: string,
  address: string,
): Promise<ContactChannelRow | null> {
  const rows = await assistantDbQuery<ContactChannelRow>(
    `SELECT cc.id AS channelId, cc.contact_id AS contactId,
            cc.address,
            cc.external_chat_id AS externalChatId,
            c.display_name AS displayName,
            cc.status
     FROM contact_channels cc
     JOIN contacts c ON c.id = cc.contact_id
     WHERE cc.type = ? AND cc.address = ? COLLATE NOCASE
     LIMIT 1`,
    [channelType, address],
  );
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Gateway dual-write (verified outcome)
// ---------------------------------------------------------------------------

/**
 * Land the verified outcome in the authoritative gateway DB for an existing
 * channel, resilient to the assistant channel id being absent or living under
 * a different gateway UUID.
 *
 * Resolution: id-keyed update → logical-key (type,address) update →
 * insert-mirror. The gateway has a unique index on (type,address), so a
 * legacy/unmirrored channel may carry a different gateway id than the
 * assistant id, and a blind id-keyed update would silently affect 0 rows.
 *
 * Returns true if a gateway row was updated or inserted; false if the only
 * matching row is blocked/revoked (so nothing was written).
 */
function writeVerifiedGatewayChannel(params: {
  assistantChannelId: string;
  contactId: string;
  type: string;
  address: string;
  externalChatId: string;
  verifiedVia: string;
  now: number;
}): boolean {
  const {
    assistantChannelId,
    contactId,
    type,
    address,
    externalChatId,
    verifiedVia,
    now,
  } = params;
  const gwDb = getGatewayDb();
  const verifiedSet = {
    status: "active",
    policy: "allow",
    address,
    externalChatId,
    verifiedAt: now,
    verifiedVia,
    revokedReason: null,
    blockedReason: null,
    updatedAt: now,
  };

  // Never reactivate a blocked/revoked gateway row: the caller's guard only
  // inspects the assistant mirror, which may be stale relative to the
  // authoritative gateway status.
  const notBlockedOrRevoked = sql`${gwContactChannels.status} not in ('blocked', 'revoked')`;

  const byId = gwDb
    .update(gwContactChannels)
    .set(verifiedSet)
    .where(and(eq(gwContactChannels.id, assistantChannelId), notBlockedOrRevoked))
    .returning({ id: gwContactChannels.id })
    .all();
  if (byId.length > 0) return true;

  // Resolve by the gateway's logical key (type,address unique index).
  const byKey = gwDb
    .update(gwContactChannels)
    .set(verifiedSet)
    .where(
      and(
        eq(gwContactChannels.type, type),
        sql`${gwContactChannels.address} = ${address} COLLATE NOCASE`,
        notBlockedOrRevoked,
      ),
    )
    .returning({ id: gwContactChannels.id })
    .all();
  if (byKey.length > 0) return true;

  // No gateway row exists, or the only match is blocked/revoked — mirror the
  // verified channel. onConflictDoNothing preserves an existing blocked/revoked
  // row (it conflicts on the (type,address) unique index), so this never
  // reactivates a blocked actor.
  gwDb
    .insert(gwContacts)
    .values({
      id: contactId,
      displayName: address,
      role: "contact",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .run();
  const inserted = gwDb
    .insert(gwContactChannels)
    .values({
      id: assistantChannelId,
      contactId,
      type,
      isPrimary: false,
      interactionCount: 0,
      createdAt: now,
      ...verifiedSet,
    })
    .onConflictDoNothing()
    .returning({ id: gwContactChannels.id })
    .all();
  // An empty result means the (type,address) unique index conflicted with a
  // blocked/revoked row, so nothing was written.
  return inserted.length > 0;
}

/**
 * Read the authoritative gateway row status for an actor by the logical key
 * (type, address) COLLATE NOCASE. The gateway is the source of truth; the
 * assistant mirror can lag behind a block/revoke landed gateway-side.
 */
function gatewayChannelStatus(type: string, address: string): string | null {
  const row = getGatewayDb()
    .select({ status: gwContactChannels.status })
    .from(gwContactChannels)
    .where(
      and(
        eq(gwContactChannels.type, type),
        sql`${gwContactChannels.address} = ${address} COLLATE NOCASE`,
      ),
    )
    .get();
  return row?.status ?? null;
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
 *
 * Returns `{ verified: false }` when the verification is rejected because the
 * authoritative gateway row (or the assistant mirror) is blocked/revoked, so
 * the caller can suppress the success reply. Returns `{ verified: true }` on
 * the normal activate/insert paths.
 */
export async function upsertVerifiedContactChannel(params: {
  sourceChannel: string;
  externalUserId: string;
  externalChatId: string;
  displayName?: string;
  username?: string;
  verifiedVia?: string;
}): Promise<{ verified: boolean }> {
  const now = Date.now();
  const { sourceChannel, externalChatId, displayName, username } = params;
  const verifiedVia = params.verifiedVia ?? "challenge";

  const address =
    canonicalizeInboundIdentity(sourceChannel, params.externalUserId) ??
    params.externalUserId;
  const contactDisplayName = displayName ?? username ?? address;

  // Check if a channel for this actor already exists.
  const existing = await assistantDbQuery<{
    channelId: string;
    contactId: string;
    channelStatus: string;
  }>(
    `SELECT cc.id AS channelId, cc.contact_id AS contactId, cc.status AS channelStatus
     FROM contact_channels cc
     WHERE cc.type = ? AND cc.address = ? COLLATE NOCASE
     ORDER BY
       CASE cc.status
         WHEN 'active' THEN 0
         WHEN 'unverified' THEN 1
         ELSE 2
       END,
       cc.updated_at DESC
     LIMIT 1`,
    [sourceChannel, address],
  );

  if (existing.length > 0) {
    const row = existing[0];

    // Don't overwrite blocked or revoked channels (assistant mirror guard).
    if (row.channelStatus === "blocked" || row.channelStatus === "revoked") {
      log.warn(
        { sourceChannel, address, status: row.channelStatus },
        "Skipping upsert: channel is blocked or revoked",
      );
      return { verified: false };
    }

    // The gateway is the source of truth: a blocked/revoked gateway row rejects
    // the verification even when the assistant mirror is still claimable. Don't
    // activate the assistant mirror and signal the caller to suppress success.
    // A missing gateway row is the legitimate happy path (legacy/unmirrored).
    const gwStatus = gatewayChannelStatus(sourceChannel, address);
    if (gwStatus === "blocked" || gwStatus === "revoked") {
      log.warn(
        { sourceChannel, address, status: gwStatus },
        "Skipping upsert: authoritative gateway channel is blocked or revoked",
      );
      return { verified: false };
    }

    // Update existing channel
    await assistantDbRun(
      `UPDATE contact_channels
       SET address = ?,
           status = 'active', policy = 'allow',
           external_chat_id = ?,
           verified_at = ?, verified_via = ?,
           revoked_reason = NULL, blocked_reason = NULL,
           updated_at = ?
       WHERE id = ?`,
      [address, externalChatId, now, verifiedVia, now, row.channelId],
    );

    // Dual-write to gateway DB. Best-effort: a gateway failure must not break
    // inbound verification UX (the code already matched). The assistant
    // channel id may not exist in the gateway DB (legacy/unmirrored channel)
    // or may live under a different gateway UUID, so resolve by logical key.
    try {
      const wrote = writeVerifiedGatewayChannel({
        assistantChannelId: row.channelId,
        contactId: row.contactId,
        type: sourceChannel,
        address,
        externalChatId,
        verifiedVia,
        now,
      });
      // The gateway pre-check passed, so a write is expected. A false here means
      // a blocked/revoked row appeared between the pre-check and the write —
      // treat it as a rejection so the caller suppresses the success reply.
      if (!wrote) {
        log.warn(
          { sourceChannel, address },
          "Gateway write ignored after pre-check: channel became blocked/revoked",
        );
        return { verified: false };
      }
    } catch (gwErr) {
      log.warn(
        { err: gwErr },
        "Gateway DB contact channel update dual-write failed",
      );
    }

    return { verified: true };
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
       (id, contact_id, type, address, is_primary, external_chat_id,
        status, policy, verified_at, verified_via, interaction_count,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, ?, 'active', 'allow', ?, ?, 0, ?, ?)`,
    [
      channelId,
      contactId,
      sourceChannel,
      address,
      externalChatId,
      now,
      verifiedVia,
      now,
      now,
    ],
  );

  // Dual-write to gateway DB
  try {
    const gwDb = getGatewayDb();
    gwDb
      .insert(gwContacts)
      .values({
        id: contactId,
        displayName: contactDisplayName,
        role: "contact",
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .run();

    gwDb
      .insert(gwContactChannels)
      .values({
        id: channelId,
        contactId,
        type: sourceChannel,
        address,
        isPrimary: false,
        externalChatId,
        status: "active",
        policy: "allow",
        verifiedAt: now,
        verifiedVia,
        interactionCount: 0,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .run();
  } catch (gwErr) {
    log.warn({ err: gwErr }, "Gateway DB contact create dual-write failed");
  }

  return { verified: true };
}

// ---------------------------------------------------------------------------
// Inbound contact seeding (dual-write)
// ---------------------------------------------------------------------------

/**
 * Create or update a contact channel for an inbound actor, preserving any
 * existing status/policy. Used to seed contact records when new users are
 * first seen on a channel.
 *
 * - Existing channel: updates display name, external_chat_id.
 *   Status and policy are left unchanged so blocked/revoked channels stay that way.
 * - New channel: inserts contact + channel with status='unverified', policy='allow'.
 *
 * Dual-writes to both the assistant DB (source of truth) and the gateway DB.
 * Skips silently when the assistant IPC socket is unavailable (test environments).
 */
export async function upsertContactChannel(params: {
  sourceChannel: string;
  externalUserId: string;
  externalChatId?: string;
  displayName?: string;
  username?: string;
}): Promise<void> {
  const { path: socketPath } = resolveIpcSocketPath("assistant");
  if (!existsSync(socketPath)) return;

  const { sourceChannel, externalChatId, displayName, username } = params;
  const now = Date.now();
  const address =
    canonicalizeInboundIdentity(sourceChannel, params.externalUserId) ??
    params.externalUserId;
  const contactDisplayName = displayName ?? username ?? address;

  const existing = await assistantDbQuery<{
    channelId: string;
    contactId: string;
    channelStatus: string;
  }>(
    `SELECT cc.id AS channelId, cc.contact_id AS contactId, cc.status AS channelStatus
     FROM contact_channels cc
     WHERE cc.type = ? AND cc.address = ? COLLATE NOCASE
     ORDER BY
       CASE cc.status
         WHEN 'active' THEN 0
         WHEN 'unverified' THEN 1
         ELSE 2
       END,
       cc.updated_at DESC
     LIMIT 1`,
    [sourceChannel, address],
  );

  if (existing.length > 0) {
    const row = existing[0];
    if (row.channelStatus === "blocked") return;

    // Update identity/display fields; preserve status and policy.
    await assistantDbRun(
      `UPDATE contacts SET display_name = ?, updated_at = ? WHERE id = ?`,
      [contactDisplayName, now, row.contactId],
    );
    await assistantDbRun(
      `UPDATE contact_channels
       SET address = ?,
           external_chat_id = COALESCE(?, external_chat_id),
           updated_at = ?
       WHERE id = ?`,
      [address, externalChatId ?? null, now, row.channelId],
    );

    try {
      const gwDb = getGatewayDb();
      gwDb
        .update(gwContactChannels)
        .set({
          address,
          ...(externalChatId ? { externalChatId } : {}),
          updatedAt: now,
        })
        .where(eq(gwContactChannels.id, row.channelId))
        .run();
    } catch (gwErr) {
      log.warn(
        { err: gwErr },
        "Gateway DB contact channel update dual-write failed",
      );
    }
    return;
  }

  // New contact + channel.
  const contactId = crypto.randomUUID();
  const channelId = crypto.randomUUID();

  await assistantDbRun(
    `INSERT OR IGNORE INTO contacts (id, display_name, role, created_at, updated_at)
     VALUES (?, ?, 'contact', ?, ?)`,
    [contactId, contactDisplayName, now, now],
  );
  await assistantDbRun(
    `INSERT OR IGNORE INTO contact_channels
       (id, contact_id, type, address, is_primary, external_chat_id,
        status, policy, interaction_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, ?, 'unverified', 'allow', 0, ?, ?)`,
    [
      channelId,
      contactId,
      sourceChannel,
      address,
      externalChatId ?? null,
      now,
      now,
    ],
  );

  try {
    const gwDb = getGatewayDb();
    gwDb
      .insert(gwContacts)
      .values({
        id: contactId,
        displayName: contactDisplayName,
        role: "contact",
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .run();
    gwDb
      .insert(gwContactChannels)
      .values({
        id: channelId,
        contactId,
        type: sourceChannel,
        address,
        isPrimary: false,
        externalChatId: externalChatId ?? null,
        status: "unverified",
        policy: "allow",
        interactionCount: 0,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .run();
  } catch (gwErr) {
    log.warn(
      { err: gwErr },
      "Gateway DB contact channel create dual-write failed",
    );
  }
}
