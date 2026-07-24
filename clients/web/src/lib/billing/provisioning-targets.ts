/**
 * Pure provisioning-target helpers shared across domains.
 *
 * `targetsMet` compares an assistant's actual machine size / provisioned
 * storage against purchased ceilings. It lives here (rather than in the
 * pro-onboarding domain) so cross-domain consumers — e.g. the onboarding
 * hatching screen — can reuse it without an ESLint-banned cross-domain import.
 */

import type { MachineSizeEnum } from "@/generated/api/types.gen";
import { machineSizeRank } from "./machine-sizes";

export interface ProvisioningDimensions {
  machineSize: MachineSizeEnum | null;
  storageGib: number | null;
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
  if (!targets) {
    return false;
  }
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
