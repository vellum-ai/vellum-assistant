import {
  Coins,
  Computer,
  HardDrive,
  Mail,
  type LucideIcon,
} from "lucide-react";

import {
  FREE_CREDITS_USD,
  FREE_STORAGE_GIB,
} from "@/domains/settings/billing/plan-tier-meta";
import type { ProPackage } from "@/domains/settings/billing/package-types";
import { getPlanTierCopy } from "@/domains/settings/billing/plans/plans-copy";
import type { CurrentTiers } from "@/domains/settings/billing/use-change-tiers";
import { creditTierKeyUsd, findCreditTier } from "@/lib/billing/credit-tiers";
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
  /**
   * Give the chip a full-width row of its own instead of letting it flow in the
   * wrapping row beside the short chips. Read only by the wrapped layout
   * (`PlanTile`'s `specsWrap`); the vertical stack gives every chip its own row
   * already.
   */
  ownRow?: boolean;
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

export interface PackageSpecsOptions {
  /**
   * Replaces the credits chip's dollar label, for the `obscure-credits`
   * surfaces that describe the bundle as the package's own usage allowance
   * instead of naming an amount.
   */
  obscuredUsageLabel?: string;
  /**
   * Localized chip text for a package with a `usage_label` (e.g.
   * "Mighty Usage included" via `planCard.usageIncludedChip`). Supplied by
   * the caller because this pure module has no `t()`; without it the chip
   * falls back to the untranslated dollar wording.
   */
  usageIncludedLabel?: string;
}

/**
 * The spec chips for a package, in mock order: machine, storage, credits,
 * then any static extras from the tier copy (today only the email/subdomain
 * row on Super and Ultra; a new extra inherits the Mail icon until it needs
 * its own mapping).
 *
 * The machine and storage chips are short enough to sit side by side; the
 * credits chip and the extras are sentences, so they take a row each wherever
 * the chips are laid out as a wrapping row.
 */
export function packageSpecs(
  pkg: ProPackage,
  opts?: PackageSpecsOptions,
): PlanSpec[] {
  const credits = pkg.credits_usd ?? FREE_CREDITS_USD;
  const extras = getPlanTierCopy(pkg.key)?.extraFeatures ?? [];
  return [
    { icon: Computer, label: `${machineLabel(pkg)} Machine` },
    { icon: HardDrive, label: `${pkg.storage_gib} GB Storage` },
    // `usageIncludedLabel` carries the localized wording for the catalog's
    // `usage_label` ("Mighty Usage"), the bundle's Stripe product name, so
    // the chip matches the invoice line. The dollar fallback covers a package
    // with no usage label. It is cents-aware like every other price on these
    // surfaces, so a sub-dollar bundle reads "$0.50 in credits included"
    // rather than "$0.5".
    {
      icon: Coins,
      label:
        opts?.obscuredUsageLabel ??
        opts?.usageIncludedLabel ??
        `${formatDollars(credits * 100)} in credits included`,
      ownRow: true,
    },
    ...extras.map((label) => ({ icon: Mail, label, ownRow: true })),
  ];
}

/**
 * The Free plan's spec chips: the shared small baseline, the free storage
 * allowance, and pay-as-you-go credits (no bundle to price).
 */
export function freePlanSpecs(): PlanSpec[] {
  return [
    { icon: Computer, label: `${STANDARD_MACHINE_LABEL} Machine` },
    { icon: HardDrive, label: `${FREE_STORAGE_GIB} GB Storage` },
    { icon: Coins, label: "Pay as you go credits", ownRow: true },
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
    // Named for the package's usage allowance where one exists, matching the
    // invoice line; the dollar wording covers packages with no usage label.
    pkg?.usage_label ?? creditRowLabel(credits),
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
    // The catalog label is preferred: it is the bundle's Stripe product name
    // ("Mighty Usage" for the offered tiers, "50 credits" for a grandfathered
    // retired one), so this row matches the subscriber's invoice line.
    //
    // A held/deprecated tier absent from the catalog has no label, so it
    // falls back to the amount recovered from the tier key (credits_<usd>)
    // with its monthly cadence, and the paid bundle still shows instead of
    // being silently dropped. A bundle whose amount can't be resolved at all
    // stays generic rather than claiming a cadence for an unknown quantity.
    const label = findCreditTier(proPlan, current.creditTier)?.label;
    const usd = creditTierKeyUsd(current.creditTier);
    rows.push(label ?? (usd != null ? `${usd} credits/mo` : "Credit bundle"));
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
