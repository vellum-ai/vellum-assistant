/**
 * Channel-specific delivery logic for inbound events.
 *
 * Handles verification reply persistence, per-segment delivery progress
 * tracking, and the deliver-once guard for terminal reply idempotency.
 */

import { eq } from "drizzle-orm";

import { getDb } from "./db-connection.js";
import { channelInboundEvents } from "./schema.js";

// ── Per-segment delivery progress ──────────────────────────────────
//
// When a split reply (multiple text segments from tool boundaries) fails
// partway through delivery, we persist how many segments were sent so
// the retry can resume from where it left off.

/**
 * Update the delivered segment count after successful delivery of one
 * or more segments. Called incrementally as segments are sent.
 */
export function updateDeliveredSegmentCount(
  eventId: string,
  count: number,
): void {
  const db = getDb();
  db.update(channelInboundEvents)
    .set({ deliveredSegmentCount: count, updatedAt: Date.now() })
    .where(eq(channelInboundEvents.id, eventId))
    .run();
}

// ── Deliver-once guard for terminal reply idempotency ────────────────
//
// When both the main poll (processChannelMessageWithApprovals) and the
// post-decision poll (schedulePostDecisionDelivery) race to deliver the
// final assistant reply for the same run, this guard ensures only one
// of them actually sends the message. The guard is run-scoped so old
// assistant messages from previous runs are not affected.

/** Map from runId to insertion timestamp (ms). */
const deliveredRuns = new Map<string, number>();

/** TTL for delivery claims — 10 minutes, well beyond the poll max-wait. */
const CLAIM_TTL_MS = 10 * 60 * 1000;

/** Hard cap to bound memory even under sustained high throughput within the TTL window. */
const MAX_DELIVERED_RUNS = 10_000;

/**
 * Atomically claim the right to deliver the final reply for a run.
 * Returns `true` if this caller won the claim (and should proceed with
 * delivery). Returns `false` if another caller already claimed it.
 *
 * This is an in-memory guard — sufficient because both racing pollers
 * execute within the same process. The Map is never persisted; on restart
 * there are no in-flight pollers to race.
 *
 * Claims are evicted after CLAIM_TTL_MS. When the hard cap is reached,
 * only TTL-expired entries are evicted — active claims are never removed
 * early, preserving the at-most-once delivery guarantee.
 */
export function claimRunDelivery(runId: string): boolean {
  if (deliveredRuns.has(runId)) return false;
  if (deliveredRuns.size >= MAX_DELIVERED_RUNS) {
    // Only evict entries whose TTL has expired. Map iteration order
    // matches insertion order, so oldest entries come first.
    const now = Date.now();
    for (const [id, insertedAt] of deliveredRuns) {
      if (now - insertedAt >= CLAIM_TTL_MS) {
        deliveredRuns.delete(id);
      } else {
        // Remaining entries are newer; stop scanning.
        break;
      }
    }
  }
  const now = Date.now();
  deliveredRuns.set(runId, now);
  setTimeout(() => deliveredRuns.delete(runId), CLAIM_TTL_MS);
  return true;
}

/**
 * Reset the deliver-once guard for a run. Used to release a claim when
 * delivery fails (so the other racing poller can retry) and in tests
 * for isolation between test cases.
 */
export function resetRunDeliveryClaim(runId: string): void {
  deliveredRuns.delete(runId);
}

/**
 * Clear all delivery claims. Used in tests for full isolation.
 */
export function resetAllRunDeliveryClaims(): void {
  deliveredRuns.clear();
}
