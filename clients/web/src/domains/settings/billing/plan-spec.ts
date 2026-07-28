import { Coins, Computer, HardDrive, type LucideIcon } from "lucide-react";

import {
  FREE_CREDITS_USD,
  FREE_STORAGE_GIB,
} from "@/domains/settings/billing/plan-tier-meta";
import type { ProPackage } from "@/domains/settings/billing/package-types";
import {
  creditRowLabel,
  formatDollars,
  storageRowLabel,
} from "@/domains/settings/components/tier-pricing";
import type { MachineSizeEnum } from "@/generated/api/types.gen";
import { SIZE_DESCRIPTION, SIZE_LABEL } from "@/lib/billing/machine-sizes";

/** A single spec chip: an icon and its label. */
export interface PlanSpec {
  icon: LucideIcon;
  label: string;
  /** Render the chip as a wrap-capable pill for long summary labels. */
  multiline?: boolean;
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
    // Cents-aware like every other price on these surfaces, so a sub-dollar
    // bundle reads "$0.50 credits" rather than "$0.5 credits".
    { icon: Coins, label: `${formatDollars(credits * 100)} credits` },
    { icon: HardDrive, label: `${storage} GB` },
  ];
}

/**
 * Sentence-case highlight rows for the package-switch confirm modal, in mock
 * order: machine → storage → credits, then any static extras from the tier
 * copy. Longer than `packageSpecs`' chips — the modal has the full card width
 * for the machine's resource detail, e.g. "Large machine (4 vCPU, 8 GiB)".
 */
export function packageHighlights(
  pkg: ProPackage | null,
  extra: readonly string[] = [],
): string[] {
  const credits = pkg?.credits_usd ?? FREE_CREDITS_USD;
  const storage = pkg?.storage_gib ?? FREE_STORAGE_GIB;
  // A package with no `machine_size` runs on the shared small baseline. Beyond
  // that `machine_size` is a loose string, so an unrecognized size has no preset
  // — drop the detail rather than render "(undefined)", as `machineLabel` does.
  const size = (pkg?.machine_size as MachineSizeEnum | null) ?? "small";
  const resources = SIZE_DESCRIPTION[size];
  return [
    `${machineLabel(pkg)} machine${resources ? ` (${resources})` : ""}`,
    storageRowLabel(storage),
    creditRowLabel(credits),
    ...extra,
  ];
}
