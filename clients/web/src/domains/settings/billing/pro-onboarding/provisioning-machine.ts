/**
 * Pure state machine for the post-checkout provisioning screen.
 *
 * The platform auto-resizes the assistant machine/storage from the Stripe
 * subscribe webhook, so the client only *observes*: first that the
 * subscription flipped to Pro (CONFIRMING), then that the assistant's actual
 * machine size / provisioned storage caught up to the purchased targets
 * (WAITING → RESIZING → DONE). No React here — `deriveProvisioningState` is a
 * pure function over polled inputs so every transition is unit-testable.
 */

import type { MachineSizeEnum } from "@/generated/api/types.gen";
import { machineSizeRank } from "@/lib/billing/machine-sizes";

import { PROVISION_STALL_MS, PROVISION_WAIT_GRACE_MS } from "./utils";

export type ProvisioningStateKind =
  | "CONFIRMING"
  | "CONFIRM_TIMEOUT"
  | "WAITING"
  | "RESIZING"
  | "DONE"
  | "NOT_APPLICABLE"
  | "STALLED";

/**
 * Server-reported provisioning verdict (from the ensure-provisioned endpoint,
 * adopted by a later PR). Overrides client-side inference, except that
 * DONE-by-actuals beats a stale verdict — and that a currently in-flight
 * resize beats both, since no verdict may complete the flow while the machine
 * is still rolling out.
 */
export type ProvisioningServerVerdict =
  | "already_done"
  | "in_progress"
  | "started"
  | "not_applicable";

export interface ProvisioningDimensions {
  machineSize: MachineSizeEnum | null;
  storageGib: number | null;
}

export interface DeriveProvisioningInput {
  planId: string | null | undefined;
  /** Purchased ceilings; a null dimension means nothing to provision there. */
  targets: ProvisioningDimensions | null;
  /** Last-known assistant machine size / provisioned storage. */
  actuals: ProvisioningDimensions | null;
  /** First non-null actuals ever observed (frozen by the hook). */
  initialActuals: ProvisioningDimensions | null;
  /** A resize operation is currently observed in flight. */
  resizeOperationInFlight: boolean;
  /** A resize operation was observed at some point (latched by the hook). */
  sawOperation: boolean;
  /**
   * Elapsed ms since the current observation window began — pro confirm, or
   * the latest stalled-resize resume. Null before pro is confirmed.
   */
  msSinceWatchStart: number | null;
  /** The confirm-phase poll timed out without observing plan_id == "pro". */
  confirmExpired: boolean;
  serverVerdict?: ProvisioningServerVerdict | null;
  /**
   * The operational-status query has produced a reading *after* the actuals
   * were first seen to meet the targets. Only consulted under a provisional
   * verdict — see the completion rules in `deriveProvisioningState`. Defaults
   * to true so callers without a verdict (and every pure-inference test) are
   * unaffected.
   */
  statusObservedSinceTargetsMet?: boolean;
}

export interface ProvisioningSnapshot {
  state: ProvisioningStateKind;
  /** Still WAITING past the grace window — the UI softens its copy. */
  softWaiting: boolean;
}

/**
 * A dimension with a null target is satisfied (e.g. the Mighty package has no
 * machine tier); a non-null target needs a known actual at or above it.
 * Machine sizes compare by rank, storage by GiB.
 */
export function targetsMet(
  targets: ProvisioningDimensions | null,
  actuals: ProvisioningDimensions | null,
): boolean {
  if (!targets) return false;
  const machineMet =
    targets.machineSize == null ||
    (actuals?.machineSize != null &&
      machineSizeRank(actuals.machineSize) >=
        machineSizeRank(targets.machineSize));
  const storageMet =
    targets.storageGib == null ||
    (actuals?.storageGib != null && actuals.storageGib >= targets.storageGib);
  return machineMet && storageMet;
}

export function deriveProvisioningState(
  input: DeriveProvisioningInput,
): ProvisioningSnapshot {
  const {
    planId,
    targets,
    actuals,
    initialActuals,
    resizeOperationInFlight,
    sawOperation,
    msSinceWatchStart,
    confirmExpired,
    serverVerdict = null,
    statusObservedSinceTargetsMet = true,
  } = input;

  if (planId !== "pro") {
    return {
      state: confirmExpired ? "CONFIRM_TIMEOUT" : "CONFIRMING",
      softWaiting: false,
    };
  }

  const operationObserved = sawOperation || resizeOperationInFlight;

  // A *currently observed* resize dominates every terminal state, because the
  // actuals go high before the machine is usable: the platform persists the
  // effective machine_size / provisioned_storage_gib in the same call that
  // leaves the operation marker WAITING_FOR_PVC/WAITING_FOR_READY, so targets
  // read as met from the moment the resize is accepted while the pod is still
  // restarting. Completing here would clear `machineBusy` and let the domain
  // step fire its guardian write into a gateway that is still coming back up.
  // Falling through holds the flow in RESIZING; the stall clock below is still
  // the escape when a marker never clears. Note this deliberately keys on
  // `resizeOperationInFlight`, not `operationObserved` — a resize seen only in
  // the past must still be allowed to settle.
  // `started` / `in_progress` are the server saying a rollout is underway but
  // NOT finished. Under one of those, targets-met alone can no longer stand in
  // for completion: the assistant and operational-status queries poll
  // independently, so the assistant poll can land the target sizes while the
  // status query still holds its pre-resize snapshot — a window in which
  // nothing has reported the marker even though the platform created it (it
  // creates the marker *before* it writes the effective sizes).
  //
  // The verdict itself cannot be the anchor: `started` only means the resize
  // was queued on a worker (the response never waits on it) and `in_progress`
  // may be a submission racing ahead of the worker's first marker, so a status
  // read taken right after either verdict can still be the pre-marker
  // snapshot.
  //
  // What does hold is the platform's write order — `resize_assistant` creates
  // the marker BEFORE it persists the effective sizes. So an actuals read that
  // shows the targets met necessarily happened after the marker existed, and
  // any status reading taken after *that* either finds the marker (still
  // rolling out — the guard above holds) or finds it retired (genuinely
  // converged). A resize we watched appear and clear is equally good evidence.
  //
  // `already_done` stays terminal on its own because the server checked the
  // marker itself — `collect_pro_provisioning_state` combines targets-met AND
  // no-active-operation before it answers that.
  const provisionalVerdict =
    serverVerdict === "started" || serverVerdict === "in_progress";
  const rolloutConfirmedOver = sawOperation || statusObservedSinceTargetsMet;

  if (!resizeOperationInFlight) {
    // Outside a provisional verdict: DONE-by-actuals still wins over a stale
    // verdict. A quick resize can finish between polls (or behind transient
    // endpoint failures) without ever being observed, so when no operation was
    // seen, disambiguate by the first actuals ever observed: if they were below
    // the targets, a resize must have run → DONE. NOT_APPLICABLE is reserved
    // for first-observed actuals that already met the targets (null
    // initialActuals means the current actuals ARE the first observation — the
    // hook freezes them as the snapshot one render later).
    const completed = provisionalVerdict
      ? rolloutConfirmedOver
      : operationObserved ||
        serverVerdict === "already_done" ||
        (initialActuals != null && !targetsMet(targets, initialActuals));

    if (targetsMet(targets, actuals)) {
      if (completed) {
        return { state: "DONE", softWaiting: false };
      }
      // An uncorroborated provisional verdict keeps observing (falls through to
      // RESIZING) rather than completing or declaring there was nothing to do.
      if (!provisionalVerdict) {
        return { state: "NOT_APPLICABLE", softWaiting: false };
      }
    } else {
      if (serverVerdict === "already_done") {
        return { state: "DONE", softWaiting: false };
      }
      if (serverVerdict === "not_applicable") {
        return { state: "NOT_APPLICABLE", softWaiting: false };
      }
    }
  }

  if (msSinceWatchStart != null && msSinceWatchStart >= PROVISION_STALL_MS) {
    return { state: "STALLED", softWaiting: false };
  }

  if (
    operationObserved ||
    serverVerdict === "started" ||
    serverVerdict === "in_progress"
  ) {
    return { state: "RESIZING", softWaiting: false };
  }

  return {
    state: "WAITING",
    softWaiting:
      msSinceWatchStart != null && msSinceWatchStart >= PROVISION_WAIT_GRACE_MS,
  };
}
