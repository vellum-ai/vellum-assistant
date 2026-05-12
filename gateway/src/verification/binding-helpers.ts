/**
 * Guardian binding helpers for gateway-owned verification.
 *
 * Provides lookup, conflict detection, and revocation of existing bindings.
 * Binding creation uses the existing createGuardianBinding from
 * gateway/src/auth/guardian-bootstrap.ts which already dual-writes.
 *
 * All assistant DB access is via raw SQL (assistantDbQuery/assistantDbRun).
 */

import { eq } from "drizzle-orm";

import {
  assistantDbQuery,
  assistantDbRun,
} from "../db/assistant-db-proxy.js";
import { getGatewayDb } from "../db/connection.js";
import { contactChannels as gwContactChannels } from "../db/schema.js";
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
): Promise<{ externalUserId: string | null } | null> {
  const rows = await assistantDbQuery<{ externalUserId: string | null }>(
    `SELECT cc.external_user_id AS externalUserId
     FROM contacts c
     JOIN contact_channels cc ON cc.contact_id = c.id
     WHERE c.role = 'guardian' AND cc.type = ? AND cc.status = 'active'
     LIMIT 1`,
    [channel],
  );
  return rows[0] ?? null;
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
  const rows = await assistantDbQuery<{ maxUpdatedAt: number | null }>(
    `SELECT MAX(COALESCE(cc.updated_at, cc.created_at)) AS maxUpdatedAt
     FROM contacts c
     JOIN contact_channels cc ON cc.contact_id = c.id
     WHERE c.role = 'guardian'
       AND cc.type = ?
       AND cc.status IN ('active', 'revoked')`,
    [channel],
  );
  return rows[0]?.maxUpdatedAt ?? null;
}

/**
 * Resolve the canonical principal ID for the guardian.
 * Looks up the vellum channel binding's principal; falls back to the provided ID.
 */
export async function resolveCanonicalPrincipal(
  fallback: string,
): Promise<string> {
  const rows = await assistantDbQuery<{ principalId: string | null }>(
    `SELECT c.principal_id AS principalId
     FROM contacts c
     JOIN contact_channels cc ON cc.contact_id = c.id
     WHERE c.role = 'guardian' AND cc.type = 'vellum' AND cc.status = 'active'
     LIMIT 1`,
    [],
  );
  return rows[0]?.principalId ?? fallback;
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

  const revokedRows = await assistantDbQuery<{ id: string }>(
    `SELECT cc.id
     FROM contacts c
     JOIN contact_channels cc ON cc.contact_id = c.id
     WHERE c.role = 'guardian' AND cc.type = ? AND cc.status = 'active'`,
    [channel],
  );

  if (revokedRows.length === 0) return;

  const ids = revokedRows.map((r) => r.id);
  const placeholders = ids.map(() => "?").join(", ");

  await assistantDbRun(
    `UPDATE contact_channels
     SET status = 'revoked', policy = 'deny', updated_at = ?
     WHERE id IN (${placeholders})`,
    [now, ...ids],
  );

  // Gateway DB dual-write
  try {
    const gwDb = getGatewayDb();
    for (const id of ids) {
      gwDb.update(gwContactChannels)
        .set({ status: "revoked", policy: "deny", updatedAt: now })
        .where(eq(gwContactChannels.id, id))
        .run();
    }
  } catch (gwErr) {
    log.warn({ err: gwErr }, "Gateway DB revoke dual-write failed (best-effort)");
  }
}
