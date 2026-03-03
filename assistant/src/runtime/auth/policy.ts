/**
 * Policy epoch management.
 *
 * The policy epoch is a monotonic counter embedded in every JWT. When
 * the auth policy changes (e.g., scope profiles are redefined), the
 * epoch is bumped, and tokens carrying a stale epoch are rejected.
 * This gives us a hard revocation mechanism without maintaining a
 * per-token blocklist.
 */

/** Current policy epoch — bump this when auth policy changes. */
export const CURRENT_POLICY_EPOCH = 1;

/** Returns true if the given epoch is older than the current policy. */
export function isStaleEpoch(epoch: number): boolean {
  return epoch < CURRENT_POLICY_EPOCH;
}
