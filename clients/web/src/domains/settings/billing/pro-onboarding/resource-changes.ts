import { SIZE_LABEL } from "@/lib/billing/machine-sizes";

import type { ProvisioningDimensions } from "./provisioning-machine";

export type ResourceChangeKey = "machine" | "storage" | "credits";

export interface ResourceChange {
  key: ResourceChangeKey;
  label: string;
  from?: string;
  to: string;
}

/**
 * Flattens the provisioning targets into the ordered list of resource changes
 * the takeover rotates through, each as a current→new pair. Order is fixed at
 * machine → storage → credits to mirror the chip order in provisioning-state.
 * A dimension is included only when it has something to show; `from` is present
 * only when the pre-resize snapshot differs from the target.
 */
export function buildResourceChanges(input: {
  targets: ProvisioningDimensions;
  fromSnapshot: ProvisioningDimensions;
  creditsLabel: string | null;
}): ResourceChange[] {
  const { targets, fromSnapshot, creditsLabel } = input;
  const changes: ResourceChange[] = [];

  if (targets.machineSize != null) {
    changes.push({
      key: "machine",
      label: "Machine",
      from:
        fromSnapshot.machineSize != null &&
        fromSnapshot.machineSize !== targets.machineSize
          ? SIZE_LABEL[fromSnapshot.machineSize]
          : undefined,
      to: SIZE_LABEL[targets.machineSize],
    });
  }

  if (targets.storageGib != null) {
    changes.push({
      key: "storage",
      label: "Storage",
      from:
        fromSnapshot.storageGib != null &&
        fromSnapshot.storageGib !== targets.storageGib
          ? `${fromSnapshot.storageGib} GiB`
          : undefined,
      to: `${targets.storageGib} GiB`,
    });
  }

  if (creditsLabel != null) {
    changes.push({ key: "credits", label: "Credits", to: creditsLabel });
  }

  return changes;
}
