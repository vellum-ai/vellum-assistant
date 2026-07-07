/**
 * Guardian-row integrity detection for the gateway ACL DB.
 *
 * Every onboarded install has a `role='guardian'` contact row; when that row
 * is lost (partial restore, manual deletion) the trust-verdict resolver would
 * silently classify every sender — including the guardian — as a plain
 * stranger. This module distinguishes that broken state from a genuinely
 * fresh install so the resolver can stamp `resolutionFailed` (consumers fail
 * closed) and reporting can fire loudly (guardian-integrity-reporter.ts).
 *
 * Evidence signals — ANY one proves a guardian existed at some point:
 *  - `contacts` has any row: contacts are only ever created by guardian
 *    onboarding or guardian-issued invites.
 *  - `actor_token_records` / `actor_refresh_token_records` has any row:
 *    tokens are minted exclusively for a guardian principal at pairing, and
 *    survive even when the guardian contact row is deleted.
 * Both are single-row LIMIT 1 reads. The `one_time_migrations` m0008 key is
 * deliberately NOT consulted: the migration runner records it on installs
 * that had nothing to backfill, so it cannot discriminate a fresh install
 * from a prior-guardian install.
 *
 * Detection never blocks or crashes the gateway: callers treat a thrown
 * check as "no stamp" and serve the plain verdict (degraded, loud).
 */

import { eq } from "drizzle-orm";

import { getGatewayDb } from "../db/connection.js";
import {
  actorRefreshTokenRecords,
  actorTokenRecords,
  contacts,
} from "../db/schema.js";
import { reportMissingGuardian } from "../guardian-integrity-reporter.js";

export type GuardianIntegrityState = "ok" | "missing_guardian";

/**
 * TTL on the computed state so the per-verdict overhead is one cached check.
 * Guardian-binding writes bust the cache eagerly (createGuardianBinding);
 * the TTL bounds staleness for every other write path.
 */
const STATE_TTL_MS = 30_000;

let cached: { state: GuardianIntegrityState; at: number } | null = null;

function evidenceSignals(): { hasContacts: boolean; hasActorTokens: boolean } {
  const db = getGatewayDb();
  const hasContacts =
    db.select({ id: contacts.id }).from(contacts).limit(1).get() !== undefined;
  const hasActorTokens =
    db
      .select({ id: actorTokenRecords.id })
      .from(actorTokenRecords)
      .limit(1)
      .get() !== undefined ||
    db
      .select({ id: actorRefreshTokenRecords.id })
      .from(actorRefreshTokenRecords)
      .limit(1)
      .get() !== undefined;
  return { hasContacts, hasActorTokens };
}

/** Whether the gateway DB shows any trace of a guardian having existed. */
export function hasEvidenceOfPriorGuardian(): boolean {
  const { hasContacts, hasActorTokens } = evidenceSignals();
  return hasContacts || hasActorTokens;
}

/**
 * `missing_guardian` when zero `role='guardian'` contact rows exist AND the
 * DB carries evidence of prior onboarding; `ok` otherwise (healthy install or
 * genuinely fresh install). Cached with a short TTL; a `missing_guardian`
 * computation fires the fail-loud reporter (rate-limited there).
 */
export function guardianIntegrityState(): GuardianIntegrityState {
  const now = Date.now();
  if (cached && now - cached.at < STATE_TTL_MS) {
    return cached.state;
  }
  const state = computeState();
  cached = { state, at: now };
  return state;
}

function computeState(): GuardianIntegrityState {
  const guardianRow = getGatewayDb()
    .select({ id: contacts.id })
    .from(contacts)
    .where(eq(contacts.role, "guardian"))
    .limit(1)
    .get();
  if (guardianRow) {
    return "ok";
  }

  const { hasContacts, hasActorTokens } = evidenceSignals();
  if (!hasContacts && !hasActorTokens) {
    return "ok";
  }

  reportMissingGuardian({
    has_contacts: hasContacts,
    has_actor_tokens: hasActorTokens,
  });
  return "missing_guardian";
}

/**
 * Drop the cached state so the next read recomputes — called after
 * guardian-binding writes so a re-seeded guardian is observed immediately.
 */
export function bustGuardianIntegrityCache(): void {
  cached = null;
}
