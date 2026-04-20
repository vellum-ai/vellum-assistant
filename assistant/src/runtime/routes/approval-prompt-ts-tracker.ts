/**
 * In-memory tracker for approval prompt message timestamps.
 *
 * Scopes guardian reaction approvals so only reactions on a known
 * approval prompt can resolve a pending request. Without this, a stray
 * 👍/✅ on any message in the guardian chat could approve a pending
 * request (since reactions are now admitted from any subscribed channel,
 * not just tracked bot threads).
 *
 * Entries expire after `APPROVAL_PROMPT_TS_TTL_MS` (matches the guardian
 * approval TTL of 30 minutes, plus grace). Populated when an approval
 * prompt is successfully delivered; consulted before applying a guardian
 * reaction decision.
 */

const APPROVAL_PROMPT_TS_TTL_MS = 35 * 60 * 1000;

const tracked = new Map<string, number>();

function key(channel: string, chatId: string, ts: string): string {
  return `${channel}\u0000${chatId}\u0000${ts}`;
}

function pruneExpired(now: number): void {
  for (const [k, expiresAt] of tracked) {
    if (expiresAt <= now) tracked.delete(k);
  }
}

export function trackApprovalPromptTs(
  channel: string,
  chatId: string,
  ts: string,
): void {
  const now = Date.now();
  pruneExpired(now);
  tracked.set(key(channel, chatId, ts), now + APPROVAL_PROMPT_TS_TTL_MS);
}

export function isTrackedApprovalPromptTs(
  channel: string,
  chatId: string,
  ts: string,
): boolean {
  const k = key(channel, chatId, ts);
  const expiresAt = tracked.get(k);
  if (expiresAt === undefined) return false;
  if (expiresAt <= Date.now()) {
    tracked.delete(k);
    return false;
  }
  return true;
}

/** @internal Test-only — clear all tracked entries. */
export function _clearApprovalPromptTsTrackerForTesting(): void {
  tracked.clear();
}
