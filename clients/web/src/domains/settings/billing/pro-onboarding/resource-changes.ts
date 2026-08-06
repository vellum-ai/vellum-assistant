import { SIZE_LABEL } from "@/lib/billing/machine-sizes";

import type { MachineSizeEnum } from "@/generated/api/types.gen";
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
 *
 * Machine renders only when it moves. A snapshot equal to the target describes
 * a pod that stays exactly where it is, and a chip for it asserts a resize that
 * never runs; the live targets carry the tier ceiling, which is non-null for
 * any paid tier, so a credit-only or storage-only change would otherwise paint
 * a machine row out of nothing. A null snapshot is the fresh-hatch (or
 * not-yet-read) case and still renders, with no from-side.
 *
 * Storage renders only when it grows. PVCs never shrink (vembda raises on a
 * decrease and Kubernetes cannot reduce a claim), so a lowered BILLED storage
 * tier leaves the volume exactly where it is, and `30 GB → 10 GB` would claim a
 * data loss that never happens. A null snapshot is the fresh-hatch case and
 * still renders.
 *
 * `machineFloor` is display-only. It covers machine-less packages, whose null
 * machine target otherwise drops the machine row entirely, and it mirrors the
 * server's `_machine_tier_ceiling_size(None) == "small"`. It must never feed
 * `targetsMet`: a non-null machine target requires non-null actuals and hangs
 * the upgrade takeover on a fresh hatch. The floor row also needs a real
 * difference on the from-side, because a null machine target is trivially met
 * and a pod already at or below the ceiling gets no cap marker created
 * server-side, so a floor row without that difference arrives pre-checked and
 * asserts a downsize that never ran.
 */
export function buildResourceChanges(input: {
  targets: ProvisioningDimensions;
  fromSnapshot: ProvisioningDimensions;
  machineFloor?: MachineSizeEnum | null;
  credits: { from: string; to: string } | null;
}): ResourceChange[] {
  const { targets, fromSnapshot, machineFloor, credits } = input;
  const changes: ResourceChange[] = [];

  if (targets.machineSize != null) {
    if (fromSnapshot.machineSize !== targets.machineSize) {
      changes.push({
        key: "machine",
        label: "Machine",
        from:
          fromSnapshot.machineSize != null
            ? SIZE_LABEL[fromSnapshot.machineSize]
            : undefined,
        to: SIZE_LABEL[targets.machineSize],
      });
    }
  } else if (
    machineFloor != null &&
    fromSnapshot.machineSize != null &&
    fromSnapshot.machineSize !== machineFloor
  ) {
    changes.push({
      key: "machine",
      label: "Machine",
      from: SIZE_LABEL[fromSnapshot.machineSize],
      to: SIZE_LABEL[machineFloor],
    });
  }

  if (
    targets.storageGib != null &&
    (fromSnapshot.storageGib == null ||
      targets.storageGib > fromSnapshot.storageGib)
  ) {
    changes.push({
      key: "storage",
      label: "Storage",
      from:
        fromSnapshot.storageGib != null
          ? `${fromSnapshot.storageGib} GB`
          : undefined,
      to: `${targets.storageGib} GB`,
    });
  }

  if (credits != null) {
    changes.push({
      key: "credits",
      label: "Credits",
      from: credits.from,
      to: credits.to,
    });
  }

  return changes;
}
