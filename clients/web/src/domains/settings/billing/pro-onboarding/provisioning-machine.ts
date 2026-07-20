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
 * DONE-by-actuals beats a stale verdict.
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
function targetsMet(
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
  } = input;

  if (planId !== "pro") {
    return {
      state: confirmExpired ? "CONFIRM_TIMEOUT" : "CONFIRMING",
      softWaiting: false,
    };
  }

  const operationObserved = sawOperation || resizeOperationInFlight;

  if (targetsMet(targets, actuals)) {
    // DONE-by-actuals wins over a stale in_progress/started verdict. A quick
    // resize can also finish between polls (or behind transient endpoint
    // failures) without ever being observed, so when no operation was seen,
    // disambiguate by the first actuals ever observed: if they were below the
    // targets, a resize must have run → DONE. NOT_APPLICABLE is reserved for
    // first-observed actuals that already met the targets (null initialActuals
    // means the current actuals ARE the first observation — the hook freezes
    // them as the snapshot one render later).
    if (
      operationObserved ||
      serverVerdict === "already_done" ||
      serverVerdict === "started" ||
      serverVerdict === "in_progress" ||
      (initialActuals != null && !targetsMet(targets, initialActuals))
    ) {
      return { state: "DONE", softWaiting: false };
    }
    return { state: "NOT_APPLICABLE", softWaiting: false };
  }

  if (serverVerdict === "already_done") {
    return { state: "DONE", softWaiting: false };
  }
  if (serverVerdict === "not_applicable") {
    return { state: "NOT_APPLICABLE", softWaiting: false };
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
