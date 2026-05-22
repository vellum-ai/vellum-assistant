import type { MachineSizeEnum } from "@/generated/api/types.gen.js";

/**
 * Pro tier ceilings → machine sizes the org may run at within that tier.
 * Keys mirror `BillingAccount.max_machine_tier` ("medium" | "large" | "xl");
 * values are `MachineSizeEnum` strings sent to the resize mutation.
 */
export const TIER_TO_SIZES: Record<string, MachineSizeEnum[]> = {
  medium: ["small", "medium"],
  large: ["small", "medium", "large"],
  xl: ["small", "medium", "large", "extra_large"],
};

export const SIZE_LABEL: Record<MachineSizeEnum, string> = {
  small: "Small",
  medium: "Medium",
  large: "Large",
  extra_large: "Extra Large",
};

// Descriptions reflect the cpu_limit / memory_limit from
// `MACHINE_SIZE_RESOURCE_PRESETS` in `django/app/domain_models/constants.py`,
// rounded to integers where the underlying value is a whole number of cores
// (e.g. small's 2000m CPU limit displays as 2 vCPU). Keep these in sync if
// the backend presets change.
export const SIZE_DESCRIPTION: Record<MachineSizeEnum, string> = {
  small: "2 vCPU, 3 GiB",
  medium: "2.5 vCPU, 5 GiB",
  large: "4 vCPU, 8 GiB",
  extra_large: "4 vCPU, 16 GiB",
};

/**
 * Canonical small→large ordering used to bound selection and disable
 * downsizes. Index into this to compare two `MachineSizeEnum` values.
 */
export const MACHINE_SIZE_ORDER: MachineSizeEnum[] = [
  "small",
  "medium",
  "large",
  "extra_large",
];

/** Rank of a machine size in the small→large ordering. */
export function machineSizeRank(size: MachineSizeEnum): number {
  return MACHINE_SIZE_ORDER.indexOf(size);
}
