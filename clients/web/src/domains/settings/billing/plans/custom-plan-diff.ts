/**
 * Pure diff/recap computation for the Custom Plan configurator.
 *
 * Owns the recap-row and signed-delta logic that the modal renders, kept free
 * of React/JSX/tokens so it can be unit-tested in isolation and reused across
 * the base-checkout and Pro-reconfigure paths. The modal supplies the live
 * dropdown selection plus the seed (current plan), and consumes the returned
 * rows and raw cents to render the recap and price delta.
 */

import {
  formatDollars,
  formatMonthly,
} from "@/domains/settings/components/tier-pricing";
import type {
  CreditTier,
  CreditTierEnum,
  MachineTier,
  MachineTierEnum,
  ProPlan,
  StorageTier,
  StorageTierEnum,
} from "@/generated/api/types.gen";

import type { CustomPlanSeed } from "./custom-plan-modal";

/** Sentinel for the "No extra credits" dropdown entry (Dropdown is generic over string, cannot carry real null). */
export const NO_EXTRA_CREDITS = "__none__";
export type CreditChoice = CreditTierEnum | typeof NO_EXTRA_CREDITS;

export interface CustomPlanDiffRow {
  /** Stable React key. */
  key: string;
  /** Label for the current/new value. */
  label: string;
  /** Present only when this dimension changed from the seed: previous value's label, shown struck-through above the new one. */
  previousLabel?: string;
  /** True when the dimension changed from the seed — new value gets the green check. */
  changed: boolean;
}

export interface CustomPlanDiff {
  /** Total for the seed (previous) config incl. base fee; null for base checkout (no seed). */
  previousTotalCents: number | null;
  /** newTotal - previousTotal; null for base checkout. */
  deltaCents: number | null;
  rows: CustomPlanDiffRow[];
}

/** `tier.description`, e.g. "Medium machine (2.5 vCPU, 5 GiB)". */
function machineLabel(tier: MachineTier): string {
  return tier.description;
}

/** e.g. "30 GB storage". */
function storageLabel(tier: StorageTier): string {
  return `${tier.storage_gib} GB storage`;
}

/** "No extra credits" for null; else "$50 of bundled credits". */
function creditLabel(tier: CreditTier | null): string {
  return tier
    ? `${formatDollars(tier.credits_usd * 100)} of bundled credits`
    : "No extra credits";
}

/** Single "none" token for the "No extra credits" choice/seed. */
const NO_CREDIT_KEY = "none";

export function computeCustomPlanDiff(input: {
  proPlan: ProPlan;
  seed: CustomPlanSeed | null;
  machineTier: MachineTierEnum | "";
  storageTier: StorageTierEnum | "";
  creditChoice: CreditChoice | "";
}): CustomPlanDiff {
  const { proPlan, seed, machineTier, storageTier, creditChoice } = input;

  const machineTiers = proPlan.machine_tiers;
  // Resolve against the FULL catalog, legacy tiers included. This helper only
  // resolves already-chosen values into prices/labels — it never offers dropdown
  // options — so a known tier value (e.g. a legacy current/seed storage tier a
  // subscriber still pays for) must resolve to its real price/label. The
  // `!legacy` option-gating lives in the modal, not here.
  const storageTiers = proPlan.storage_tiers;
  const creditTiers = proPlan.credit_tiers ?? [];

  const selectedMachine =
    machineTiers.find((t) => t.tier === machineTier) ?? null;
  const selectedStorage =
    storageTiers.find((t) => t.tier === storageTier) ?? null;
  const selectedCredit =
    creditChoice && creditChoice !== NO_EXTRA_CREDITS
      ? (creditTiers.find((t) => t.tier === creditChoice) ?? null)
      : null;

  const seedMachine =
    seed != null
      ? (machineTiers.find((t) => t.tier === seed.machineTier) ?? null)
      : null;
  const seedStorage =
    seed != null
      ? (storageTiers.find((t) => t.tier === seed.storageTier) ?? null)
      : null;
  const seedCredit =
    seed != null && seed.creditTier != null
      ? (creditTiers.find((t) => t.tier === seed.creditTier) ?? null)
      : null;

  const rows: CustomPlanDiffRow[] = [
    {
      key: "base",
      label: `Pro base plan — ${formatMonthly(proPlan.base_price_cents)}`,
      changed: false,
    },
  ];

  if (selectedMachine != null) {
    const changed = seed != null && seedMachine?.tier !== selectedMachine.tier;
    rows.push({
      key: "machine",
      label: machineLabel(selectedMachine),
      // A null baseline seed machine has no representable previous value → omit
      // previousLabel, still changed: true.
      previousLabel:
        changed && seedMachine != null ? machineLabel(seedMachine) : undefined,
      changed,
    });
  }

  if (selectedStorage != null) {
    const changed = seed != null && seedStorage?.tier !== selectedStorage.tier;
    rows.push({
      key: "storage",
      label: storageLabel(selectedStorage),
      previousLabel:
        changed && seedStorage != null ? storageLabel(seedStorage) : undefined,
      changed,
    });
  }

  if (creditChoice !== "") {
    // Detect the change from the RAW seed key, not the resolved objects: a
    // deprecated seed bundle (absent from proPlan.credit_tiers) resolves to
    // null, which would otherwise read identically to "No extra credits" and
    // hide the change.
    const seedCreditKey =
      seed != null ? (seed.creditTier ?? NO_CREDIT_KEY) : null;
    const selectedCreditKey =
      creditChoice === NO_EXTRA_CREDITS ? NO_CREDIT_KEY : creditChoice;
    const changed = seed != null && seedCreditKey !== selectedCreditKey;
    rows.push({
      key: "credit",
      label: creditLabel(selectedCredit),
      // A deprecated seed bundle's price/label is absent from the catalog, so
      // seedCredit is null and we omit previousLabel there (mirroring a
      // null-baseline seed machine) rather than fabricate one — previousTotalCents
      // is best-effort for that upstream-gated case.
      previousLabel:
        changed && (seed.creditTier == null || seedCredit != null)
          ? creditLabel(seedCredit)
          : undefined,
      changed,
    });
  }

  const newTotalCents =
    proPlan.base_price_cents +
    (selectedMachine?.price_cents ?? 0) +
    (selectedStorage?.price_cents ?? 0) +
    (selectedCredit?.price_cents ?? 0);

  if (seed == null) {
    return { previousTotalCents: null, deltaCents: null, rows };
  }

  const previousTotalCents =
    proPlan.base_price_cents +
    (seedMachine?.price_cents ?? 0) +
    (seedStorage?.price_cents ?? 0) +
    (seedCredit?.price_cents ?? 0);

  return {
    previousTotalCents,
    deltaCents: newTotalCents - previousTotalCents,
    rows,
  };
}
