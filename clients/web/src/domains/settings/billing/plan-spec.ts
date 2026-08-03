import { Coins, Computer, HardDrive, type LucideIcon } from "lucide-react";

import {
  FREE_CREDITS_USD,
  FREE_STORAGE_GIB,
} from "@/domains/settings/billing/plan-tier-meta";
import type { ProPackage } from "@/domains/settings/billing/package-types";
import { findCreditTier } from "@/domains/settings/billing/pro-onboarding/use-provisioning-credits";
import type { CurrentTiers } from "@/domains/settings/billing/use-change-tiers";
import { creditTierKeyUsd } from "@/lib/billing/credit-tiers";
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
 * The catalog capability row each tier dimension replaces. A row is only
 * dropped when its dimension actually produced a concrete value: a sub holding
 * no credit bundle keeps "Pay-as-you-go and bundled credits", which is still
 * true of its plan and is the only thing left saying so.
 */
const CAPABILITY_ROW = {
  machine: "Configurable machine size",
  storage: "Configurable storage",
  credits: "Pay-as-you-go and bundled credits",
} as const;

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
  // Static map first, so casing stays stable for the tiers this bundle knows;
  // then the catalog's own label, so a tier the platform adds reads the same
  // here as it does in the tier picker; the raw key only as a last resort.
  const machine = current.machineTier
    ? (MACHINE_TIER_LABEL[current.machineTier] ??
      proPlan.machine_tiers.find((t) => t.tier === current.machineTier)
        ?.label ??
      current.machineTier)
    : STANDARD_MACHINE_LABEL;
  const rows = [`${machine} Machine`];
  if (current.storageGib != null) {
    rows.push(`${current.storageGib} GB`);
  }
  if (current.creditTier != null) {
    // Built from the structured `credits_usd` rather than `CreditTier.label`:
    // the label is server-owned copy, so composing a cadence onto it would read
    // as "50 credits/mo/mo" the day it starts carrying one itself.
    //
    // A held/deprecated tier absent from the catalog has no structured amount,
    // so it falls back to the tier key (credits_<usd>) and the paid bundle
    // still shows instead of being silently dropped.
    const usd =
      findCreditTier(proPlan, current.creditTier)?.credits_usd ??
      creditTierKeyUsd(current.creditTier);
    // Credits refresh every month, unlike the machine and storage rows, which
    // are standing capacity. A bundle whose amount can't be resolved at all
    // stays generic rather than claiming a cadence for an unknown quantity.
    rows.push(usd != null ? `${usd} credits/mo` : "Credit bundle");
  }
  return rows;
}

/**
 * The full checklist for a current Pro subscriber: their real tier rows, then
 * every catalog feature those rows did not replace.
 *
 * The surviving rows come from the live catalog rather than a client-side
 * mirror, so an entitlement the platform adds appears with no web change, and a
 * dimension the sub has no concrete value for keeps its generic capability row
 * instead of vanishing.
 */
export function currentPlanFeatures(
  current: CurrentTiers,
  proPlan: ProPlan,
): string[] {
  // The machine row always renders, falling back to the small baseline.
  const superseded = new Set<string>([CAPABILITY_ROW.machine]);
  if (current.storageGib != null) {
    superseded.add(CAPABILITY_ROW.storage);
  }
  if (current.creditTier != null) {
    superseded.add(CAPABILITY_ROW.credits);
  }
  return [
    ...currentTierRows(current, proPlan),
    ...proPlan.included_features.filter((f) => !superseded.has(f)),
  ];
}
