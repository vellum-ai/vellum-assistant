/**
 * Guardian request expiry sweep.
 *
 * Each round reads a bounded batch of pending requests past their
 * `expiresAt` and, per request, runs the expiry side effects (withdrawing
 * the approval cards on every surface, notifying the requester, releasing
 * any in-memory pending interaction), and only then confirms with the
 * gateway's per-request expire CAS. The status flip is the receipt that the
 * side effects ran, not the announcement that they should: a lost IPC
 * response, a timeout, or a crash at any point leaves the row pending and
 * past-deadline, so the next round lists it again and re-runs its fan-out.
 *
 * That order is safe because every decision path checks `expiresAt` before
 * any write: a past-deadline row is undecidable while it waits for its
 * fan-out. The cost is at-least-once side effects: a round that dies
 * between the notice and the CAS re-notifies the requester next round,
 * which is the correct trade against silently losing the withdrawal and the
 * notice, since a stale card is an actionable control on every surface that
 * renders buttons.
 *
 * Requester notices are delivered straight to the requester's channel, not
 * the guardian-facing notification pipeline, and the guardian stays
 * passive, since the withdrawn card already reflects expiry.
 *
 * Unreachable-gateway posture: log and skip the round — the next tick
 * retries, and expiry only ever moves forward.
 */

import { withdrawGuardianRequestCards } from "../../approvals/guardian-card-withdrawal.js";
import { notifyExpiredGuardianRequest } from "../../approvals/guardian-expiry-notifier.js";
import {
  expireGuardianRequest,
  type GuardianRequestWire,
  listExpiredPendingGuardianRequests,
} from "../../channels/gateway-guardian-requests.js";
import { getLogger } from "../../util/logger.js";

const log = getLogger("guardian-expiry-sweep");

/** Interval at which the expiry sweep runs (60 seconds). */
const SWEEP_INTERVAL_MS = 60_000;

/**
 * Requests handled per round. Bounds every round's IPC payload and fan-out
 * however large a backlog grows; the remainder drains on later rounds.
 */
const SWEEP_BATCH_LIMIT = 50;

/** Timer handle for the sweep so it can be stopped in tests and shutdown. */
let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** Guard against overlapping sweeps. */
let sweepInProgress = false;

/**
 * Run one expiry sweep round: read a bounded batch of past-deadline pending
 * requests, run each one's side effects, then confirm each with the
 * gateway's per-request expire CAS (a concurrent decision that wins the
 * race is never overwritten; the CAS requires `pending`). Returns the
 * count of requests whose full cycle completed.
 */
export async function runGuardianExpirySweep(): Promise<number> {
  let stale: GuardianRequestWire[];
  try {
    stale = await listExpiredPendingGuardianRequests(SWEEP_BATCH_LIMIT);
  } catch (err) {
    log.warn(
      { err },
      "Guardian expiry sweep skipped — gateway unreachable; next round retries",
    );
    return 0;
  }

  let expiredCount = 0;
  for (const request of stale) {
    log.info(
      {
        event: "guardian_request_expired",
        requestId: request.id,
        kind: request.kind,
        expiresAt: request.expiresAt,
      },
      "Expiring guardian request via sweep",
    );

    // Withdraw the now-stale approval cards on every surface. No origin
    // channel — the expiry is system-driven, so all surfaces (including
    // in-app) are withdrawn. Incomplete withdrawal defers the whole
    // request: the notice has not been sent yet, so the retry next round
    // repeats only idempotent card edits, never a delivered notice. A
    // surface that fails persistently keeps its request in the pending set
    // with this warning every round, so the stall is observable rather
    // than silent.
    const withdrawal = await withdrawGuardianRequestCards({
      request,
      status: "expired",
    });
    if (!withdrawal.complete) {
      log.warn(
        { requestId: request.id },
        "Card withdrawal incomplete; leaving the request pending for the next round",
      );
      continue;
    }

    // Notify the requester their request expired and release any in-memory
    // pending interaction. A failed notice also defers the request: an
    // unsent notice is exactly what a retry can still deliver.
    const notice = await notifyExpiredGuardianRequest(request);
    if (!notice.complete) {
      log.warn(
        { requestId: request.id },
        "Expiry notice incomplete; leaving the request pending for the next round",
      );
      continue;
    }

    // The receipt: only after the side effects does the row leave the
    // pending set. A failure here leaves it discoverable for the next
    // round rather than silently done; the notice-then-lost-confirmation
    // window is the one duplicate-notice case, and it is bounded to that
    // crash or timeout.
    try {
      await expireGuardianRequest(request.id);
      expiredCount += 1;
    } catch (err) {
      log.warn(
        { err, requestId: request.id },
        "Expire confirmation failed; the next round re-runs this request",
      );
    }
  }

  if (expiredCount > 0) {
    log.info(
      {
        event: "guardian_expiry_sweep_complete",
        expiredCount,
      },
      `Guardian expiry sweep: expired ${expiredCount} request(s)`,
    );
  }

  return expiredCount;
}

/**
 * Start the periodic guardian expiry sweep. Idempotent — calling it
 * multiple times reuses the same timer.
 */
export function startGuardianExpirySweep(): void {
  if (sweepTimer) {
    return;
  }
  sweepTimer = setInterval(() => {
    if (sweepInProgress) {
      return;
    }
    sweepInProgress = true;
    void runGuardianExpirySweep()
      .catch((err) => {
        log.error({ err }, "Guardian expiry sweep failed");
      })
      .finally(() => {
        sweepInProgress = false;
      });
  }, SWEEP_INTERVAL_MS);
}

/**
 * Stop the periodic guardian expiry sweep. Used in tests and shutdown.
 */
export function stopGuardianExpirySweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  sweepInProgress = false;
}
