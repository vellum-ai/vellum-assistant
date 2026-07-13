/**
 * Guardian request expiry sweep.
 *
 * Periodically asks the gateway to CAS-expire pending guardian requests
 * whose `expiresAt` timestamp has passed (`guardian_requests_sweep_expired`),
 * so stale requests are cleaned up even when no follow-up traffic arrives
 * from either the guardian or the requester.
 *
 * The gateway owns the status transition (the single source of truth); the
 * daemon fans out the side effects for each expired row it returns:
 * withdrawing the approval cards on every surface, notifying the requester
 * that their request expired, and releasing any in-memory pending
 * interaction. Requester notices are delivered straight to the requester's
 * channel — not the guardian-facing notification pipeline — and the guardian
 * stays passive, since the withdrawn card already reflects expiry.
 *
 * Unreachable-gateway posture: log and skip the round — the next tick
 * retries, and expiry only ever moves forward.
 */

import { withdrawGuardianRequestCards } from "../../approvals/guardian-card-withdrawal.js";
import { notifyExpiredGuardianRequest } from "../../approvals/guardian-expiry-notifier.js";
import {
  type GuardianRequestWire,
  sweepExpiredGuardianRequests,
} from "../../channels/gateway-guardian-requests.js";
import { getLogger } from "../../util/logger.js";

const log = getLogger("guardian-expiry-sweep");

/** Interval at which the expiry sweep runs (60 seconds). */
const SWEEP_INTERVAL_MS = 60_000;

/** Timer handle for the sweep so it can be stopped in tests and shutdown. */
let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** Guard against overlapping sweeps. */
let sweepInProgress = false;

/**
 * Run one expiry sweep round: the gateway CAS-expires every pending request
 * past its `expiresAt` (a concurrent decision that wins the race is never
 * overwritten), then the daemon runs the per-request side effects. Returns
 * the count of requests transitioned to expired.
 */
export async function runGuardianExpirySweep(): Promise<number> {
  let expired: GuardianRequestWire[];
  try {
    expired = await sweepExpiredGuardianRequests();
  } catch (err) {
    log.warn(
      { err },
      "Guardian expiry sweep skipped — gateway unreachable; next round retries",
    );
    return 0;
  }

  // The sweep returns the full rows, so the side-effect fan-out can never be
  // stranded by a failed follow-up read after the status flip.
  for (const request of expired) {
    log.info(
      {
        event: "guardian_request_expired",
        requestId: request.id,
        kind: request.kind,
        expiresAt: request.expiresAt,
      },
      "Expired guardian request via sweep",
    );

    // Withdraw the now-stale approval cards on every surface. No origin
    // channel — the expiry is system-driven, so all surfaces (including
    // in-app) are withdrawn. Best-effort and non-throwing.
    await withdrawGuardianRequestCards({
      request,
      status: "expired",
    });

    // Notify the requester their request expired and release any in-memory
    // pending interaction. Best-effort and non-throwing, like the card
    // withdrawal above.
    await notifyExpiredGuardianRequest(request);
  }

  if (expired.length > 0) {
    log.info(
      {
        event: "guardian_expiry_sweep_complete",
        expiredCount: expired.length,
      },
      `Guardian expiry sweep: expired ${expired.length} request(s)`,
    );
  }

  return expired.length;
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
