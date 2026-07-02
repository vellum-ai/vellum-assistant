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
            c.display_name AS displayName
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
  allowRevokedReactivation?: boolean;
}): boolean {
  const {
    assistantChannelId,
    contactId,
    type,
    address,
    externalChatId,
    verifiedVia,
    now,
    allowRevokedReactivation,
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

  // Blocked is never reactivated. Revoked is reactivated only on the invite
  // path (allowRevokedReactivation); otherwise the gateway row stays revoked.
  const reactivatable = allowRevokedReactivation
    ? sql`${gwContactChannels.status} not in ('blocked')`
    : sql`${gwContactChannels.status} not in ('blocked', 'revoked')`;

  const byId = gwDb
    .update(gwContactChannels)
    .set(verifiedSet)
    .where(and(eq(gwContactChannels.id, assistantChannelId), reactivatable))
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
        reactivatable,
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
 * Re-parent a gateway channel to the invite's target contact, ensuring the
 * target contact row exists first. Best-effort: a gateway DB error is logged,
 * not thrown, so a legitimate activation still proceeds.
 */
function reassignChannelContact(params: {
  type: string;
  address: string;
  toContactId: string;
  displayName: string;
  now: number;
}): void {
  const { type, address, toContactId, displayName, now } = params;
  try {
    const gwDb = getGatewayDb();
    gwDb
      .insert(gwContacts)
      .values({
        id: toContactId,
        displayName,
        role: "contact",
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .run();
    // Match by the (type,address) logical key, not the assistant channel id:
    // the gateway row can live under a different UUID (m0006 reconcile), and an
    // id-only update would re-parent nothing.
    gwDb
      .update(gwContactChannels)
      .set({ contactId: toContactId, updatedAt: now })
      .where(
        and(
          eq(gwContactChannels.type, type),
          sql`${gwContactChannels.address} = ${address} COLLATE NOCASE`,
        ),
      )
      .run();
  } catch (gwErr) {
    log.warn({ err: gwErr }, "Gateway channel reassignment dual-write failed");
  }
}

/**
 * Read the authoritative gateway row status for an actor by the logical key
 * (type, address) COLLATE NOCASE. The gateway is the source of truth; the
 * assistant mirror can lag behind a block/revoke landed gateway-side.
 */
export function gatewayChannelStatus(type: string, address: string): string | null {
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

export interface VerifiedChannelRow {
  id: string;
  contactId: string;
  type: string;
  address: string;
  status: string;
  verifiedAt: number | null;
  verifiedVia: string | null;
}

const VERIFIED_CHANNEL_PROJECTION = {
  id: gwContactChannels.id,
  contactId: gwContactChannels.contactId,
  type: gwContactChannels.type,
  address: gwContactChannels.address,
  status: gwContactChannels.status,
  verifiedAt: gwContactChannels.verifiedAt,
  verifiedVia: gwContactChannels.verifiedVia,
};

/**
 * Read the authoritative gateway channel row by the logical key
 * (type, address) COLLATE NOCASE. Used to project an upsert result back to the
 * caller; the source-of-truth row carries the post-write state.
 */
export function getGatewayChannelByKey(
  type: string,
  address: string,
): VerifiedChannelRow | null {
  const row = getGatewayDb()
    .select(VERIFIED_CHANNEL_PROJECTION)
    .from(gwContactChannels)
    .where(
      and(
        eq(gwContactChannels.type, type),
        sql`${gwContactChannels.address} = ${address} COLLATE NOCASE`,
      ),
    )
    .get();
  return row ?? null;
}

/**
 * Read the authoritative gateway channel row by `(type, externalChatId)`.
 * Fallback member resolution for callers that only carry a delivery chat id
 * (no actor external id).
 */
export function getGatewayChannelByExternalChatId(
  type: string,
  externalChatId: string,
): VerifiedChannelRow | null {
  const row = getGatewayDb()
    .select(VERIFIED_CHANNEL_PROJECTION)
    .from(gwContactChannels)
    .where(
      and(
        eq(gwContactChannels.type, type),
        eq(gwContactChannels.externalChatId, externalChatId),
      ),
    )
    .get();
  return row ?? null;
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
 * Returns `{ verified: false }` when the authoritative gateway row is
 * blocked/revoked, or when the authoritative gateway write fails, so the caller
 * suppresses the success reply (the mirror carries identity/info only, so a
 * lost gateway write must fail closed). Returns `{ verified: true }` on the
 * normal activate/insert paths.
 */
export async function upsertVerifiedContactChannel(params: {
  sourceChannel: string;
  externalUserId: string;
  externalChatId: string;
  displayName?: string;
  username?: string;
  verifiedVia?: string;
  contactId?: string;
  allowRevokedReactivation?: boolean;
  /**
   * When true, assistant-mirror (IPC) failures are logged, never thrown — the
   * result reflects the gateway ACL write alone. Used post-claim by invite
   * redemption, where the mirror is best-effort and a throw would regress an
   * already-consumed invite to a non-intercepted path.
   */
  softMirrorFailures?: boolean;
}): Promise<{ verified: boolean }> {
  const now = Date.now();
  const {
    sourceChannel,
    externalChatId,
    displayName,
    username,
    contactId: targetContactId,
    allowRevokedReactivation,
  } = params;
  const verifiedVia = params.verifiedVia ?? "challenge";
  const mirrorSoft = params.softMirrorFailures === true;
  const runMirror = async (
    op: () => Promise<unknown>,
    what: string,
  ): Promise<void> => {
    try {
      await op();
    } catch (mirrorErr) {
      if (!mirrorSoft) throw mirrorErr;
      log.warn(
        { err: mirrorErr, sourceChannel },
        `Assistant mirror ${what} failed (soft); gateway ACL result stands`,
      );
    }
  };

  const address =
    canonicalizeInboundIdentity(sourceChannel, params.externalUserId) ??
    params.externalUserId;
  const contactDisplayName = displayName ?? username ?? address;

  // Resolve the existing channel's identity (id, parent contact) only. The
  // ACL/status decision is owned by the gateway pre-check below; the most
  // recently updated mirror row is preferred. In soft mode a failed lookup
  // falls through to the create path: the gateway write resolves by logical
  // key either way, and the mirror writes below are soft too.
  let existing: { channelId: string; contactId: string }[];
  try {
    existing = await assistantDbQuery<{
      channelId: string;
      contactId: string;
    }>(
      `SELECT cc.id AS channelId, cc.contact_id AS contactId
       FROM contact_channels cc
       WHERE cc.type = ? AND cc.address = ? COLLATE NOCASE
       ORDER BY cc.updated_at DESC
       LIMIT 1`,
      [sourceChannel, address],
    );
  } catch (mirrorErr) {
    if (!mirrorSoft) throw mirrorErr;
    log.warn(
      { err: mirrorErr, sourceChannel },
      "Assistant mirror lookup failed (soft); proceeding gateway-only",
    );
    existing = [];
  }

  // The gateway is the source of truth: a blocked/revoked gateway row rejects
  // the verification, gating BOTH the existing-channel update and the
  // new-insert path so no active mirror is created for a blocked actor. A
  // missing gateway row is the legitimate happy path (legacy/unmirrored).
  const gwStatus = gatewayChannelStatus(sourceChannel, address);
  if (
    gwStatus === "blocked" ||
    (gwStatus === "revoked" && !allowRevokedReactivation)
  ) {
    log.warn(
      { sourceChannel, address, status: gwStatus },
      "Skipping upsert: authoritative gateway channel is blocked or revoked",
    );
    return { verified: false };
  }

  if (existing.length > 0) {
    const row = existing[0];

    // The block/revoke decision is owned by the authoritative gateway row,
    // already gated above. The assistant mirror's status is not consulted: it
    // can lag the gateway (e.g. a gateway reactivation leaves a stale revoked
    // mirror), and gating on it would falsely reject a gateway-active channel.

    // Bind to the invite's target contact when supplied: an invite can attach a
    // redeemer's existing channel to a different contact, so reassign the
    // channel's parent (gateway + assistant mirror) before activating.
    const boundContactId =
      targetContactId && targetContactId !== row.contactId
        ? targetContactId
        : row.contactId;
    if (boundContactId !== row.contactId) {
      reassignChannelContact({
        type: sourceChannel,
        address,
        toContactId: boundContactId,
        displayName: contactDisplayName,
        now,
      });
      // Best-effort: a failed assistant mirror re-parent must not block the
      // gateway activation below (the gateway is the source of truth).
      try {
        await assistantDbRun(
          `UPDATE contact_channels SET contact_id = ? WHERE id = ?`,
          [boundContactId, row.channelId],
        );
      } catch (mirrorErr) {
        log.warn(
          { err: mirrorErr },
          "Assistant mirror re-parent failed; proceeding with gateway activation",
        );
      }
    }

    // Gateway is source of truth: write it FIRST, then activate the assistant
    // mirror only if the gateway accepted the write. The assistant channel id
    // may not exist in the gateway DB (legacy/unmirrored) or live under a
    // different gateway UUID, so the helper resolves by logical key.
    let gatewayRejected = false;
    try {
      const wrote = writeVerifiedGatewayChannel({
        assistantChannelId: row.channelId,
        contactId: boundContactId,
        type: sourceChannel,
        address,
        externalChatId,
        verifiedVia,
        now,
        allowRevokedReactivation,
      });
      // The pre-check passed, so a write is expected. A false means a
      // blocked/revoked row appeared between the pre-check and the write —
      // reject WITHOUT activating the assistant mirror so a blocked actor is
      // never left active locally.
      if (!wrote) {
        log.warn(
          { sourceChannel, address },
          "Gateway write ignored after pre-check: channel became blocked/revoked",
        );
        gatewayRejected = true;
      }
    } catch (gwErr) {
      // The gateway DB is the source of truth and the assistant mirror carries
      // identity/info only, so a thrown gateway write means no DB recorded an
      // active verified channel. Fail closed rather than reply success off the
      // mirror.
      log.error(
        { err: gwErr },
        "Gateway DB contact channel update failed; failing verification closed",
      );
      gatewayRejected = true;
    }

    if (gatewayRejected) {
      return { verified: false };
    }

    // Activate the assistant mirror. ACL columns are gateway-owned; only
    // identity/info columns are written here.
    await runMirror(
      () =>
        assistantDbRun(
          `UPDATE contact_channels
           SET address = ?,
               external_chat_id = ?,
               updated_at = ?
           WHERE id = ?`,
          [address, externalChatId, now, row.channelId],
        ),
      "update",
    );

    return { verified: true };
  }

  // No existing channel: create contact + channel. Gateway is source of truth,
  // so write it FIRST and create the assistant mirror only if the gateway
  // accepted the write — never leave an active assistant channel for an actor
  // the gateway has blocked/revoked. Bind to the invite's target contact when
  // supplied so the new channel lands under it.
  const contactId = targetContactId ?? crypto.randomUUID();
  const channelId = crypto.randomUUID();

  // The parent contact is conflict-tolerant (a pre-existing contact is fine).
  // For the channel, resolve by logical key so an existing non-blocked gateway
  // row (e.g. a gateway-created unverified contact) is UPDATED to active/verified
  // rather than silently no-op'd by the (type,address) unique index.
  let gatewayRejected = false;
  try {
    if (targetContactId) {
      // The assistant mirror missed, but the gateway may already hold this
      // (type,address) row under a different contact. Re-parent it to the
      // target by logical key (writeVerifiedGatewayChannel's update set omits
      // contactId), so the gateway source of truth lands under the invite's
      // contact. No-ops when no gateway row exists.
      reassignChannelContact({
        type: sourceChannel,
        address,
        toContactId: contactId,
        displayName: contactDisplayName,
        now,
      });
    } else {
      getGatewayDb()
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
    }

    const wrote = writeVerifiedGatewayChannel({
      assistantChannelId: channelId,
      contactId,
      type: sourceChannel,
      address,
      externalChatId,
      verifiedVia,
      now,
      allowRevokedReactivation,
    });
    // A blocked/revoked gateway row appeared after the pre-check — reject
    // without creating an active assistant mirror for a blocked actor.
    if (!wrote) {
      log.warn(
        { sourceChannel, address },
        "Gateway write ignored after pre-check: channel became blocked/revoked",
      );
      gatewayRejected = true;
    }
  } catch (gwErr) {
    // The gateway DB is the source of truth and the assistant mirror carries
    // identity/info only, so a thrown gateway write means no DB recorded an
    // active verified channel. Fail closed rather than reply success off the
    // mirror.
    log.error(
      { err: gwErr },
      "Gateway DB contact create failed; failing verification closed",
    );
    gatewayRejected = true;
  }

  if (gatewayRejected) {
    return { verified: false };
  }

  // Create the assistant mirror. OR IGNORE for idempotency under retries; if the
  // channel insert fails mid-flight, the orphan contact row is harmless.
  await runMirror(async () => {
    await assistantDbRun(
      `INSERT OR IGNORE INTO contacts (id, display_name, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
      [contactId, contactDisplayName, now, now],
    );

    // ACL columns are gateway-owned; the mirror carries identity/info only and
    // relies on the schema defaults (status='unverified', policy='allow').
    await assistantDbRun(
      `INSERT OR IGNORE INTO contact_channels
         (id, contact_id, type, address, is_primary, external_chat_id,
          interaction_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, ?, 0, ?, ?)`,
      [channelId, contactId, sourceChannel, address, externalChatId, now, now],
    );
  }, "create");

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
 *   Status and policy live in the gateway DB and are left unchanged so
 *   blocked/revoked channels stay that way.
 * - New channel: inserts contact + channel. ACL columns (status, policy) are
 *   gateway-owned; the gateway DB seeds status='unverified', policy='allow'.
 *
 * Dual-writes to both the assistant DB (identity/info mirror) and the gateway
 * DB (ACL source of truth). Skips silently when the assistant IPC socket is
 * unavailable (test environments).
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
  }>(
    `SELECT cc.id AS channelId, cc.contact_id AS contactId
     FROM contact_channels cc
     WHERE cc.type = ? AND cc.address = ? COLLATE NOCASE
     ORDER BY cc.updated_at DESC
     LIMIT 1`,
    [sourceChannel, address],
  );

  if (existing.length > 0) {
    const row = existing[0];
    // Gateway DB is the source of truth for ACL: a blocked channel stays blocked.
    if (gatewayChannelStatus(sourceChannel, address) === "blocked") return;

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
    `INSERT OR IGNORE INTO contacts (id, display_name, created_at, updated_at)
     VALUES (?, ?, ?, ?)`,
    [contactId, contactDisplayName, now, now],
  );
  // ACL columns are gateway-owned; the mirror carries identity/info only and
  // relies on the schema defaults (status='unverified', policy='allow').
  await assistantDbRun(
    `INSERT OR IGNORE INTO contact_channels
       (id, contact_id, type, address, is_primary, external_chat_id,
        interaction_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, ?, 0, ?, ?)`,
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
