import { Coins, Computer, HardDrive, type LucideIcon } from "lucide-react";

import {
  FREE_CREDITS_USD,
  FREE_STORAGE_GIB,
} from "@/domains/settings/billing/plan-tier-meta";
import type { ProPackage } from "@/domains/settings/billing/package-types";
import type { MachineSizeEnum } from "@/generated/api/types.gen";
import { SIZE_LABEL } from "@/lib/billing/machine-sizes";

/** A single spec chip: an icon and its label. */
export interface PlanSpec {
  icon: LucideIcon;
  label: string;
}

/**
 * The machine a package with no `machine_size` runs on — the small baseline
 * shared by Free and machine-less Pro packages (e.g. Mighty).
 */
export const STANDARD_MACHINE_LABEL = "Small";

/** Human machine-size label for a package (or the standard small machine). */
export function machineLabel(pkg: ProPackage | null): string {
  if (!pkg?.machine_size) {
    return STANDARD_MACHINE_LABEL;
  }
  const size = pkg.machine_size as MachineSizeEnum;
  return SIZE_LABEL[size] ?? pkg.machine_size;
}

/**
 * The three absolute spec chips for a package, in mock order:
 * machine → credits → storage. A `null` package uses the free/base baseline.
 */
export function packageSpecs(pkg: ProPackage | null): PlanSpec[] {
  const credits = pkg?.credits_usd ?? FREE_CREDITS_USD;
  const storage = pkg?.storage_gib ?? FREE_STORAGE_GIB;
  return [
    { icon: Computer, label: `${machineLabel(pkg)} Machine` },
    { icon: Coins, label: `$${credits} credits` },
    { icon: HardDrive, label: `${storage} GB` },
  ];
}
