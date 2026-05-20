/**
 * In-memory consent handoff between `/onboarding/privacy` and
 * `/onboarding/hatching`. `PrivacyScreen.onStart` calls
 * `markPrivacyConsent(userId)` before navigating; `HatchingScreen`'s gate
 * checks `hasRecentPrivacyConsent(userId)` as a fallback when
 * `readTosAccepted()` returns false (storage-disabled browsers where
 * the persist silently no-ops).
 *
 * The marker carries a timestamp and the consenting user's id. Both
 * must match on read — a different user signing in within the 30s TTL
 * (e.g. session swap in the same tab) cannot pick up a prior user's
 * consent. An anonymous (null) user id never satisfies the gate, so
 * the signal can't be used to bypass auth either.
 *
 * The marker is invalid after `MAX_AGE_MS` so a stale mark can't carry
 * over (e.g. after a bfcache restore). The read side is non-mutating:
 * `HatchingScreen` relies on React strict-mode double mounts both
 * observing the same value. `clearPrivacyConsent` fires once the hatch
 * has actually succeeded — that's the only live-path invalidation.
 *
 * Refresh caveat (intentional): the signal is in-memory only, so a user
 * who refreshes `/onboarding/hatching` mid-run loses it. Refresh should
 * bounce them through the privacy screen again rather than silently
 * re-triggering a hatch.
 */

const MAX_AGE_MS = 30_000;

type ConsentMark = { userId: string; at: number };

let consent: ConsentMark | null = null;

export function markPrivacyConsent(userId: string | null): void {
  if (!userId) return;
  consent = { userId, at: Date.now() };
}

export function hasRecentPrivacyConsent(userId: string | null): boolean {
  if (consent === null) return false;
  if (!userId || consent.userId !== userId) return false;
  return Date.now() - consent.at <= MAX_AGE_MS;
}

export function clearPrivacyConsent(): void {
  consent = null;
}

// Exported for tests only — lets them reset module state between cases.
export const __testing = {
  reset(): void {
    consent = null;
  },
};
