/**
 * Cadence policy for proactive tips, as pure functions: which tip (if any)
 * shows at a given instant. Callers always pass `now` — nothing here reads
 * the clock — and gates are NOT evaluated here (the consuming hook filters
 * the catalog first).
 *
 * v1 policy: a shown tip persists for its rotation window; at most one tip
 * per window in total; a dismissal advances to the next tip only once the
 * window elapses; a dismissed tip is never reshown.
 */

import type { Tip } from "@/utils/tips-catalog";
import type { TipRecord } from "@/utils/tips-storage";

/** New-user grace: no tips until the account is at least this old. */
export const TIPS_MIN_ACCOUNT_AGE_MS = 24 * 60 * 60 * 1000;

/** A shown tip holds the slot this long; the next tip waits it out. */
export const TIP_ROTATION_INTERVAL_MS = 24 * 60 * 60 * 1000;

function isWithinRotationWindow(
  lastShownAt: number | undefined,
  now: number,
): boolean {
  return lastShownAt !== undefined && now - lastShownAt < TIP_ROTATION_INTERVAL_MS;
}

/**
 * Whether a tip may still be shown. v1: dismissed means never again — the
 * unused `tip`/`now` parameters are the seam for tunable reshow thresholds
 * later (records are timestamps for exactly that reason).
 */
export function isTipEligible(
  _tip: Tip,
  record: TipRecord | undefined,
  _now: number,
): boolean {
  return record?.dismissedAt === undefined;
}

/**
 * Pick the tip to display at `now`, or `null` when none should show.
 *
 * 1. A tip shown within the rotation window and not dismissed persists.
 * 2. Otherwise, if ANY tip was shown within the window (e.g. it was just
 *    dismissed), nothing shows — the next tip waits for the next window.
 * 3. Otherwise the first eligible tip in catalog order shows. Missing or
 *    partial records are treated as unseen.
 */
export function selectCurrentTip(
  catalog: readonly Tip[],
  records: Record<string, TipRecord>,
  now: number,
): Tip | null {
  for (const tip of catalog) {
    const record = records[tip.id];
    if (
      isTipEligible(tip, record, now) &&
      isWithinRotationWindow(record?.lastShownAt, now)
    ) {
      return tip;
    }
  }

  const anyShownWithinWindow = Object.values(records).some((record) =>
    isWithinRotationWindow(record.lastShownAt, now),
  );
  if (anyShownWithinWindow) {
    return null;
  }

  return (
    catalog.find((tip) => isTipEligible(tip, records[tip.id], now)) ?? null
  );
}
