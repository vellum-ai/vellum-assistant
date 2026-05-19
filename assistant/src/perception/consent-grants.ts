/**
 * Per-conversation consent grants for sensitive perception event kinds.
 *
 * The `screen_snapshot` and `audio_excerpt` event kinds carry information the
 * user almost certainly did not intend to feed into the assistant's reasoning
 * loop without an explicit affirmation. We gate them on a
 * `perception_consent_grants` row scoped to
 * `(scope_id, conversation_id, event_kind)`.
 *
 * The grant lifecycle:
 *
 * 1. A producer attempts to publish a gated event.
 * 2. If a non-revoked, non-expired grant exists, the event is accepted.
 * 3. If no grant exists, the route rejects with `consent_required`. The
 *    caller is responsible for issuing a `confirmation_request` with
 *    `selectedScope: "conversation"` via the existing pending-interactions
 *    flow; on approval the caller records the grant via {@link recordPerceptionConsentGrant}.
 *
 * This file owns the persistence layer only — it does not start the
 * confirmation flow itself, so we do not invent a new approval primitive.
 */

import { and, eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { getDb } from "../memory/db-connection.js";
import { perceptionConsentGrants } from "../memory/schema/perception-consent.js";

export type PerceptionConsentEventKind = "screen_snapshot" | "audio_excerpt";

const DEFAULT_SCOPE_ID = "default";

export interface PerceptionConsentLookup {
  scopeId?: string;
  conversationId: string;
  eventKind: PerceptionConsentEventKind;
  /** Reference clock. Defaults to `Date.now()`. */
  now?: number;
}

export interface PerceptionConsentGrantInput extends PerceptionConsentLookup {
  /** Optional explicit expiry. Omit for "until revoked". */
  expiresAt?: number;
}

export interface PerceptionConsentGrant {
  id: string;
  scopeId: string;
  conversationId: string;
  eventKind: PerceptionConsentEventKind;
  grantedAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
  createdAt: number;
}

function rowToGrant(row: {
  id: string;
  scopeId: string;
  conversationId: string;
  eventKind: string;
  grantedAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
  createdAt: number;
}): PerceptionConsentGrant {
  return {
    id: row.id,
    scopeId: row.scopeId,
    conversationId: row.conversationId,
    eventKind: row.eventKind as PerceptionConsentEventKind,
    grantedAt: row.grantedAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
  };
}

/**
 * Return true when there is a live (non-revoked, non-expired) grant for the
 * `(scopeId, conversationId, eventKind)` triple.
 */
export function hasActivePerceptionConsent(
  lookup: PerceptionConsentLookup,
): boolean {
  return getActivePerceptionConsent(lookup) !== null;
}

export function getActivePerceptionConsent(
  lookup: PerceptionConsentLookup,
): PerceptionConsentGrant | null {
  const scopeId = lookup.scopeId ?? DEFAULT_SCOPE_ID;
  const now = lookup.now ?? Date.now();

  const db = getDb();
  const row = db
    .select()
    .from(perceptionConsentGrants)
    .where(
      and(
        eq(perceptionConsentGrants.scopeId, scopeId),
        eq(perceptionConsentGrants.conversationId, lookup.conversationId),
        eq(perceptionConsentGrants.eventKind, lookup.eventKind),
      ),
    )
    .get();
  if (!row) return null;
  if (row.revokedAt !== null && row.revokedAt <= now) return null;
  if (row.expiresAt !== null && row.expiresAt <= now) return null;
  return rowToGrant(row);
}

/**
 * Idempotent upsert of a consent grant. Re-running with the same triple
 * refreshes `grantedAt` and clears any prior revocation, preserving the row's
 * id so callers can link audit events.
 */
export function recordPerceptionConsentGrant(
  input: PerceptionConsentGrantInput,
): PerceptionConsentGrant {
  const scopeId = input.scopeId ?? DEFAULT_SCOPE_ID;
  const now = input.now ?? Date.now();
  const expiresAt =
    typeof input.expiresAt === "number" ? input.expiresAt : null;

  const db = getDb();
  const existing = db
    .select()
    .from(perceptionConsentGrants)
    .where(
      and(
        eq(perceptionConsentGrants.scopeId, scopeId),
        eq(perceptionConsentGrants.conversationId, input.conversationId),
        eq(perceptionConsentGrants.eventKind, input.eventKind),
      ),
    )
    .get();

  if (existing) {
    db.update(perceptionConsentGrants)
      .set({
        grantedAt: now,
        expiresAt,
        revokedAt: null,
      })
      .where(eq(perceptionConsentGrants.id, existing.id))
      .run();
    return rowToGrant({
      ...existing,
      grantedAt: now,
      expiresAt,
      revokedAt: null,
    });
  }

  const id = uuid();
  db.insert(perceptionConsentGrants)
    .values({
      id,
      scopeId,
      conversationId: input.conversationId,
      eventKind: input.eventKind,
      grantedAt: now,
      expiresAt,
      revokedAt: null,
      createdAt: now,
    })
    .run();

  return {
    id,
    scopeId,
    conversationId: input.conversationId,
    eventKind: input.eventKind,
    grantedAt: now,
    expiresAt,
    revokedAt: null,
    createdAt: now,
  };
}

/**
 * Mark the grant for `(scopeId, conversationId, eventKind)` as revoked. No-op
 * when no row exists. Returns the previous state (`active`, `already_revoked`,
 * or `not_found`).
 */
export function revokePerceptionConsentGrant(
  lookup: PerceptionConsentLookup,
): "active" | "already_revoked" | "not_found" {
  const scopeId = lookup.scopeId ?? DEFAULT_SCOPE_ID;
  const now = lookup.now ?? Date.now();

  const db = getDb();
  const row = db
    .select()
    .from(perceptionConsentGrants)
    .where(
      and(
        eq(perceptionConsentGrants.scopeId, scopeId),
        eq(perceptionConsentGrants.conversationId, lookup.conversationId),
        eq(perceptionConsentGrants.eventKind, lookup.eventKind),
      ),
    )
    .get();
  if (!row) return "not_found";
  if (row.revokedAt !== null) return "already_revoked";
  db.update(perceptionConsentGrants)
    .set({ revokedAt: now })
    .where(eq(perceptionConsentGrants.id, row.id))
    .run();
  return "active";
}

/** List all grants for a conversation, useful for debugging UIs and tests. */
export function listPerceptionConsentGrantsForConversation(
  conversationId: string,
  scopeId: string = DEFAULT_SCOPE_ID,
): PerceptionConsentGrant[] {
  const db = getDb();
  const rows = db
    .select()
    .from(perceptionConsentGrants)
    .where(
      and(
        eq(perceptionConsentGrants.scopeId, scopeId),
        eq(perceptionConsentGrants.conversationId, conversationId),
      ),
    )
    .all();
  return rows.map(rowToGrant);
}
