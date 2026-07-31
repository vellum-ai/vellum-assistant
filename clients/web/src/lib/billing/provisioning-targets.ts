/**
 * Pure provisioning-target helpers shared across domains.
 *
 * `targetsMet` compares an assistant's actual machine size / provisioned
 * storage against purchased ceilings. It lives here (rather than in the
 * pro-onboarding domain) so cross-domain consumers — e.g. the onboarding
 * hatching screen — can reuse it without an ESLint-banned cross-domain import.
 */

import type {
  EnsureProvisionedResponse,
  MachineSizeEnum,
  OperationalStatus,
} from "@/generated/api/types.gen";
import { machineSizeRank } from "./machine-sizes";

export interface ProvisioningDimensions {
  machineSize: MachineSizeEnum | null;
  storageGib: number | null;
}

/** Per-dimension answer, so callers can act on machine and storage separately. */
export interface ProvisioningDimensionFlags {
  machine: boolean;
  storage: boolean;
}

/**
 * Per-dimension target check. A dimension with a null target is satisfied (e.g.
 * the Mighty package has no machine tier); a non-null target needs a known
 * actual at or above it. Machine sizes compare by rank, storage by GiB. With no
 * targets at all nothing is known, so neither dimension is met.
 */
export function dimensionTargetsMet(
  targets: ProvisioningDimensions | null,
  actuals: ProvisioningDimensions | null,
): ProvisioningDimensionFlags {
  if (!targets) {
    return { machine: false, storage: false };
  }
  return {
    machine:
      targets.machineSize == null ||
      (actuals?.machineSize != null &&
        machineSizeRank(actuals.machineSize) >=
          machineSizeRank(targets.machineSize)),
    storage:
      targets.storageGib == null ||
      (actuals?.storageGib != null && actuals.storageGib >= targets.storageGib),
  };
}

/**
 * Whether every purchased dimension has landed. Null targets are never met.
 */
export function targetsMet(
  targets: ProvisioningDimensions | null,
  actuals: ProvisioningDimensions | null,
): boolean {
  const met = dimensionTargetsMet(targets, actuals);
  return met.machine && met.storage;
}

/**
 * True while a machine/storage resize is still rolling out: the operational
 * state is itself a resize state, or the active operation is a resize. The
 * platform persists the effective machine size / provisioned storage before the
 * pod finishes restarting, so `targetsMet` can read true while a resize is still
 * in flight — completion must also wait for this to clear.
 */
export function isResizeOperationInFlight(
  status: OperationalStatus | null | undefined,
): boolean {
  if (!status) {
    return false;
  }
  if (
    status.state === "resizing_machine" ||
    status.state === "resizing_storage"
  ) {
    return true;
  }
  const operation = status.active_operation?.operation;
  return typeof operation === "string" && operation.startsWith("resize");
}

/**
 * Which dimensions are still rolling out. `isResizeOperationInFlight` matches
 * any `resize`-prefixed operation so an unknown future resize still guards
 * completion; this pins the two known dimensions instead, because an operation
 * it cannot attribute must not hold the wrong dimension pending.
 */
export function resizeDimensionsInFlight(
  status: OperationalStatus | null | undefined,
): ProvisioningDimensionFlags {
  if (!status) {
    return { machine: false, storage: false };
  }
  const operation = status.active_operation?.operation;
  return {
    machine:
      status.state === "resizing_machine" || operation === "resize_machine",
    storage:
      status.state === "resizing_storage" || operation === "resize_storage",
  };
}

/**
 * Whether an ensure-provisioned reply is a race rather than an answer. Either
 * the subscription has flipped to Pro but the platform cannot see the
 * entitlement yet (`no_active_pro`), or the entitlement is visible but the org
 * has no settled platform-hosted assistant to apply it to
 * (`no_provisionable_assistants`). Both mean nothing was queued and no target
 * is known, and both stop holding once the org settles. Callers must re-ask
 * instead of adopting it — treating it as a verdict strands them on an
 * unprovisioned assistant.
 */
export function isEntitlementRaceVerdict(
  response: Pick<EnsureProvisionedResponse, "state" | "reason">,
): boolean {
  return (
    response.state === "not_applicable" &&
    (response.reason === "no_active_pro" ||
      response.reason === "no_provisionable_assistants")
  );
}
