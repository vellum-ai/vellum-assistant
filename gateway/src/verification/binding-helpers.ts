/**
 * Guardian binding helpers for gateway-owned verification.
 *
 * Provides lookup, conflict detection, and revocation of existing bindings.
 * Binding creation uses the existing createGuardianBinding from
 * gateway/src/auth/guardian-bootstrap.ts which already dual-writes.
 *
 * Guardian lookups read the gateway DB (source of truth for ACL). Only the
 * revoke path's status write mirrors into the assistant DB (best-effort).
 */

import { and, eq, inArray, sql } from "drizzle-orm";

import { assistantDbRun } from "../db/assistant-db-proxy.js";
import { getGatewayDb } from "../db/connection.js";
import {
  contacts as gwContacts,
  contactChannels as gwContactChannels,
} from "../db/schema.js";
import { getLogger } from "../logger.js";

const log = getLogger("verification-bindings");

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/**
 * Find the existing active guardian binding for a channel.
 */
export async function getExistingGuardianBinding(
  channel: string,
): Promise<{ address: string } | null> {
  const row = getGatewayDb()
    .select({ address: gwContactChannels.address })
    .from(gwContacts)
    .innerJoin(
      gwContactChannels,
      eq(gwContactChannels.contactId, gwContacts.id),
    )
    .where(
      and(
        eq(gwContacts.role, "guardian"),
        eq(gwContactChannels.type, channel),
        eq(gwContactChannels.status, "active"),
      ),
    )
    .limit(1)
    .get();
  return row ? { address: row.address } : null;
}

/**
 * Return the most recent `contact_channels.updated_at` across any guardian
 * binding for a channel — active OR revoked. Returns `null` when no binding
 * has ever existed.
 *
 * Used as a recency backstop by sync pollers that may otherwise replay a
 * stale consumed session and reactivate a binding the guardian has since
 * revoked (or displace one bound by a sibling code path). A consumed
 * session whose own `updated_at` is older than the most recent binding
 * event for the same channel is, by definition, obsolete.
 *
 * Filters to `active` and `revoked` rows specifically. Sibling flows
 * (e.g. `contact-prompt`) can create `unverified` guardian phone rows
 * that are not bindings — including them would let a newer unverified
 * row falsely mark a legitimate fresh verification session as stale.
 */
export async function getMostRecentChannelGuardianTimestamp(
  channel: string,
): Promise<number | null> {
  const row = getGatewayDb()
    .select({
      maxUpdatedAt: sql<number | null>`MAX(COALESCE(${gwContactChannels.updatedAt}, ${gwContactChannels.createdAt}))`,
    })
    .from(gwContacts)
    .innerJoin(
      gwContactChannels,
      eq(gwContactChannels.contactId, gwContacts.id),
    )
    .where(
      and(
        eq(gwContacts.role, "guardian"),
        eq(gwContactChannels.type, channel),
        inArray(gwContactChannels.status, ["active", "revoked"]),
      ),
    )
    .get();
  return row?.maxUpdatedAt ?? null;
}

/**
 * Resolve the canonical principal ID for the guardian.
 * Looks up the vellum channel binding's principal; falls back to the provided ID.
 */
export async function resolveCanonicalPrincipal(
  fallback: string,
): Promise<string> {
  const row = getGatewayDb()
    .select({ principalId: gwContacts.principalId })
    .from(gwContacts)
    .innerJoin(
      gwContactChannels,
      eq(gwContactChannels.contactId, gwContacts.id),
    )
    .where(
      and(
        eq(gwContacts.role, "guardian"),
        eq(gwContactChannels.type, "vellum"),
        eq(gwContactChannels.status, "active"),
      ),
    )
    .limit(1)
    .get();
  return row?.principalId ?? fallback;
}

// ---------------------------------------------------------------------------
// Revocation (dual-write)
// ---------------------------------------------------------------------------

/**
 * Revoke all existing active guardian bindings for a channel.
 * Uses fetched IDs for the UPDATE to avoid TOCTOU races.
 */
export async function revokeExistingChannelGuardian(
  channel: string,
): Promise<void> {
  const now = Date.now();

  const revokedRows = getGatewayDb()
    .select({ id: gwContactChannels.id, address: gwContactChannels.address })
    .from(gwContacts)
    .innerJoin(
      gwContactChannels,
      eq(gwContactChannels.contactId, gwContacts.id),
    )
    .where(
      and(
        eq(gwContacts.role, "guardian"),
        eq(gwContactChannels.type, channel),
        eq(gwContactChannels.status, "active"),
      ),
    )
    .all();

  if (revokedRows.length === 0) return;

  // Gateway DB is the source of truth — revoke it first so revocation never
  // depends on the best-effort assistant mirror succeeding.
  const gwDb = getGatewayDb();
  for (const { id } of revokedRows) {
    gwDb
      .update(gwContactChannels)
      .set({ status: "revoked", policy: "deny", updatedAt: now })
      .where(eq(gwContactChannels.id, id))
      .run();
  }

  // Assistant mirror (best-effort): id-keyed update, then heal divergent
  // (type,address) rows whose assistant-side id differs (m0006 divergence).
  // A mirror failure must not abort the authoritative gateway revoke above.
  try {
    for (const gwChannel of revokedRows) {
      const result = await assistantDbRun(
        `UPDATE contact_channels
         SET status = 'revoked', policy = 'deny', updated_at = ?
         WHERE id = ?`,
        [now, gwChannel.id],
      );
      if (result.changes === 0) {
        await assistantDbRun(
          `UPDATE contact_channels
           SET status = 'revoked', policy = 'deny', updated_at = ?
           WHERE type = ? AND address = ? COLLATE NOCASE`,
          [now, channel, gwChannel.address],
        );
      }
    }
  } catch (mirrorErr) {
    log.warn(
      { err: mirrorErr },
      "Assistant mirror revoke failed (best-effort)",
    );
  }
}
