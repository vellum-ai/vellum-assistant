/**
 * Canonical guardian request expiry sweep.
 *
 * Periodically scans the `canonical_guardian_requests` table for pending
 * requests whose `expiresAt` timestamp has passed and transitions them to
 * the `expired` status.  This ensures that stale requests are cleaned up
 * even when no follow-up traffic arrives from either the guardian or the
 * requester.
 *
 * This sweep operates on the unified canonical domain
 * (`canonical_guardian_requests`). On expiry it transitions the request status
 * (the single source of truth), withdraws the approval cards on every surface,
 * notifies the requester that their request expired, and releases any in-memory
 * pending interaction. Requester notices are delivered straight to the
 * requester's channel — not the guardian-facing notification pipeline — and the
 * guardian stays passive, since the withdrawn card already reflects expiry.
 */

import { withdrawGuardianRequestCards } from "../../approvals/guardian-card-withdrawal.js";
import { notifyExpiredGuardianRequest } from "../../approvals/guardian-expiry-notifier.js";
import {
  listCanonicalGuardianRequests,
  resolveCanonicalGuardianRequest,
} from "../../contacts/canonical-guardian-store.js";
import { getLogger } from "../../util/logger.js";

const log = getLogger("canonical-guardian-expiry-sweep");

/** Interval at which the expiry sweep runs (60 seconds). */
const SWEEP_INTERVAL_MS = 60_000;

/** Timer handle for the sweep so it can be stopped in tests and shutdown. */
let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** Guard against overlapping sweeps. */
let sweepInProgress = false;

/**
 * Sweep all pending canonical guardian requests that have expired.
 *
 * Uses CAS resolution (`resolveCanonicalGuardianRequest`) so that a
 * concurrent decision that wins the race is never overwritten by the
 * sweep.  Returns the count of requests transitioned to expired.
 */
export async function sweepExpiredCanonicalGuardianRequests(): Promise<number> {
  const pending = listCanonicalGuardianRequests({ status: "pending" });
  const now = Date.now();
  let expiredCount = 0;

  for (const request of pending) {
    if (!request.expiresAt) continue;

    const expiresAtMs = request.expiresAt;
    if (expiresAtMs >= now) continue;

    // CAS resolve: only transition from 'pending' to 'expired'.
    // If someone resolved it between our read and this write, the CAS
    // fails harmlessly (returns null) and we skip the request.
    const resolved = resolveCanonicalGuardianRequest(request.id, "pending", {
      status: "expired",
    });

    if (resolved) {
      expiredCount++;
      log.info(
        {
          event: "canonical_request_expired",
          requestId: request.id,
          kind: request.kind,
          expiresAt: request.expiresAt,
        },
        "Expired canonical guardian request via sweep",
      );

      // Withdraw the now-stale approval cards on every surface. No origin
      // channel — the expiry is system-driven, so all surfaces (including
      // in-app) are withdrawn. Best-effort and non-throwing.
      await withdrawGuardianRequestCards({
        request: resolved,
        status: "expired",
      });

      // Notify the requester their request expired and release any in-memory
      // pending interaction. Best-effort and non-throwing, like the card
      // withdrawal above.
      await notifyExpiredGuardianRequest(resolved);
    }
  }

  if (expiredCount > 0) {
    log.info(
      { event: "canonical_expiry_sweep_complete", expiredCount },
      `Canonical guardian expiry sweep: expired ${expiredCount} request(s)`,
    );
  }

  return expiredCount;
}

/**
 * Start the periodic canonical guardian expiry sweep. Idempotent — calling
 * it multiple times reuses the same timer.
 */
export function startCanonicalGuardianExpirySweep(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    if (sweepInProgress) return;
    sweepInProgress = true;
    void sweepExpiredCanonicalGuardianRequests()
      .catch((err) => {
        log.error({ err }, "Canonical guardian expiry sweep failed");
      })
      .finally(() => {
        sweepInProgress = false;
      });
  }, SWEEP_INTERVAL_MS);
}

/**
 * Stop the periodic canonical guardian expiry sweep. Used in tests and
 * shutdown.
 */
export function stopCanonicalGuardianExpirySweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  sweepInProgress = false;
}
