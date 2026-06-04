import type { ReactNode } from "react";

import type { MachineSizeEnum } from "@/generated/api/types.gen";
import type { DropdownOption } from "@vellumai/design-library/components/dropdown";

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

/**
 * Allowed machine sizes for an org's tier, in ascending order. A null/undefined
 * or unrecognized tier returns an empty list — callers must handle the empty
 * case (e.g. a "no tier configured" warning) rather than silently defaulting to
 * a tier the org may not actually have.
 *
 * Accepts a plain string because the generated `max_machine_tier` field is
 * typed `string | null`; unknown values fall through to the empty list.
 */
export function allowedMachineSizesForTier(
  tier: string | null | undefined,
): MachineSizeEnum[] {
  return tier ? (TIER_TO_SIZES[tier] ?? []) : [];
}

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

export function buildMachineSizeOptions(
  sizes: MachineSizeEnum[],
  currentSize: MachineSizeEnum | null | undefined,
  currentSuffix: ReactNode,
): DropdownOption<MachineSizeEnum>[] {
  return sizes.map((size) => ({
    value: size,
    label: `${SIZE_LABEL[size]} — ${SIZE_DESCRIPTION[size]}`,
    suffix: size === currentSize ? currentSuffix : undefined,
  }));
}
