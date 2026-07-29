import { Coins, Computer, HardDrive, type LucideIcon } from "lucide-react";

import {
  FREE_CREDITS_USD,
  FREE_STORAGE_GIB,
} from "@/domains/settings/billing/plan-tier-meta";
import type { ProPackage } from "@/domains/settings/billing/package-types";
import { findCreditTier } from "@/domains/settings/billing/pro-onboarding/use-provisioning-credits";
import type { CurrentTiers } from "@/domains/settings/billing/use-change-tiers";
import {
  creditRowLabel,
  formatDollars,
  storageRowLabel,
} from "@/domains/settings/components/tier-pricing";
import type { MachineSizeEnum, ProPlan } from "@/generated/api/types.gen";
import {
  MACHINE_TIER_LABEL,
  SIZE_DESCRIPTION,
  SIZE_LABEL,
} from "@/lib/billing/machine-sizes";

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

/**
 * Pro entitlements that no tier encodes, so `currentTierRows` cannot derive
 * them. Mirrors the non-tier entries of `_PRO_INCLUDED_FEATURES` in platform
 * `django/app/billing/plan_views.py`; the tier-derived entries there are
 * deliberately superseded by the subscriber's real values.
 */
export const PRO_NON_TIER_FEATURES = ["Assistant email & subdomain"];

/**
 * Spec rows for a Pro sub's own tier configuration, e.g.
 * `["Medium Machine", "30 GB", "50 credits"]`. Unlike `packageSpecs`, which
 * describes a stock package, this describes what the subscriber actually holds,
 * so it also covers a Custom sub whose tiers match no package.
 *
 * A dimension with no resolvable value is dropped rather than guessed: only the
 * machine falls back, to the standard-small baseline that a package with no paid
 * machine tier runs on. Callers must not invoke this before the tier reads have
 * settled, or an unresolved config renders as that baseline.
 */
export function currentTierRows(
  current: CurrentTiers,
  proPlan: ProPlan,
): string[] {
  const machine = current.machineTier
    ? (MACHINE_TIER_LABEL[current.machineTier] ?? current.machineTier)
    : STANDARD_MACHINE_LABEL;
  const rows = [`${machine} Machine`];
  if (current.storageGib != null) {
    rows.push(`${current.storageGib} GB`);
  }
  if (current.creditTier != null) {
    // A held/deprecated credit tier absent from the catalog can't resolve to a
    // catalog label; derive the amount from the tier key (credits_<usd>) so the
    // paid bundle still shows instead of being silently dropped.
    const usd = current.creditTier.match(/^credits_(\d+)$/)?.[1];
    const label =
      findCreditTier(proPlan, current.creditTier)?.label ??
      (usd != null ? `${usd} credits` : null);
    // Credits refresh every month, unlike the machine and storage rows, which
    // are standing capacity. A bundle whose amount can't be resolved at all
    // stays generic rather than claiming a cadence for an unknown quantity.
    rows.push(label != null ? `${label}/mo` : "Credit bundle");
  }
  return rows;
}
