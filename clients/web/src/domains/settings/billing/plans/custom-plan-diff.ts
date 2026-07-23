/**
 * Pure diff/recap computation for the Custom Plan configurator — the recap rows
 * and signed price delta the modal renders, kept free of React/JSX/tokens so it
 * can be unit-tested in isolation.
 */

import {
  formatDollars,
  formatMonthly,
} from "@/domains/settings/components/tier-pricing";
import type {
  CreditTier,
  CreditTierEnum,
  MachineTierEnum,
  ProPlan,
  StorageTier,
  StorageTierEnum,
} from "@/generated/api/types.gen";

/** Sentinel for the "No extra credits" dropdown entry (Dropdown is generic over string, cannot carry real null). */
export const NO_EXTRA_CREDITS = "__none__";
export type CreditChoice = CreditTierEnum | typeof NO_EXTRA_CREDITS;

/** Shared by the credit dropdown's sentinel option and its recap row. */
export const NO_CREDITS_LABEL = "No extra credits";

/**
 * The current Pro tiers used to pre-fill the modal. Unlike a submitted
 * selection, `machineTier` may be `null` — a package with no paid machine tier
 * (baseline "Small" computer) has no `MachineTierEnum` to seed, so its machine
 * dropdown starts empty and the user picks a paid tier to continue.
 */
export interface CustomPlanSeed {
  machineTier: MachineTierEnum | null;
  storageTier: StorageTierEnum;
  creditTier: CreditTierEnum | null;
}

export interface CustomPlanDiffRow {
  key: string;
  label: string;
  /** Present only when the dimension changed and the seed value is one the catalog can label. */
  previousLabel?: string;
  changed: boolean;
}

export interface CustomPlanDiff {
  totalCents: number;
  /** Null when there is no seed, or when a seed tier is absent from the catalog and so cannot be priced. */
  previousTotalCents: number | null;
  deltaCents: number | null;
  rows: CustomPlanDiffRow[];
}

function storageLabel(tier: StorageTier): string {
  return `${tier.storage_gib} GB storage`;
}

function creditLabel(tier: CreditTier): string {
  return `${formatDollars(tier.credits_usd * 100)} of bundled credits`;
}

export function computeCustomPlanDiff(input: {
  proPlan: ProPlan;
  seed: CustomPlanSeed | null;
  machineTier: MachineTierEnum | "";
  storageTier: StorageTierEnum | "";
  creditChoice: CreditChoice | "";
}): CustomPlanDiff {
  const { proPlan, seed, machineTier, storageTier, creditChoice } = input;

  // Resolve against the full catalog, legacy tiers included: a tier a
  // subscriber still holds has to price and label even where the modal no
  // longer offers it as a choice.
  const machineTiers = proPlan.machine_tiers;
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

  // A seed tier the catalog dropped can't be labelled or priced, so its
  // dimension reads as unchanged — matching the delta the same gap suppresses.
  const seedMachineUnresolved =
    seed != null && seed.machineTier != null && seedMachine == null;
  const seedStorageUnresolved = seed != null && seedStorage == null;

  const rows: CustomPlanDiffRow[] = [
    {
      key: "base",
      label: `Pro base plan — ${formatMonthly(proPlan.base_price_cents)}`,
      changed: false,
    },
  ];

  if (selectedMachine != null) {
    const changed =
      seed != null &&
      !seedMachineUnresolved &&
      seedMachine?.tier !== selectedMachine.tier;
    rows.push({
      key: "machine",
      label: selectedMachine.description,
      previousLabel:
        changed && seedMachine != null ? seedMachine.description : undefined,
      changed,
    });
  }

  if (selectedStorage != null) {
    const changed =
      seed != null &&
      !seedStorageUnresolved &&
      seedStorage?.tier !== selectedStorage.tier;
    rows.push({
      key: "storage",
      label: storageLabel(selectedStorage),
      previousLabel:
        changed && seedStorage != null ? storageLabel(seedStorage) : undefined,
      changed,
    });
  }

  // A concrete bundle the catalog can no longer resolve gets no row at all —
  // "No extra credits" would be affirmatively false for a sub paying for one.
  const selectedCreditLabel =
    creditChoice === NO_EXTRA_CREDITS
      ? NO_CREDITS_LABEL
      : selectedCredit != null
        ? creditLabel(selectedCredit)
        : null;

  if (selectedCreditLabel != null) {
    // Compare the raw keys: a delisted seed bundle resolves to null, which
    // would otherwise read identically to "no credits" and hide the change.
    const changed =
      seed != null && (seed.creditTier ?? NO_EXTRA_CREDITS) !== creditChoice;
    const previousCreditLabel =
      seed?.creditTier == null
        ? NO_CREDITS_LABEL
        : seedCredit != null
          ? creditLabel(seedCredit)
          : undefined;
    rows.push({
      key: "credit",
      label: selectedCreditLabel,
      previousLabel: changed ? previousCreditLabel : undefined,
      changed,
    });
  }

  const newTotalCents =
    proPlan.base_price_cents +
    (selectedMachine?.price_cents ?? 0) +
    (selectedStorage?.price_cents ?? 0) +
    (selectedCredit?.price_cents ?? 0);

  // An unpriceable seed tier suppresses the comparison rather than implying $0.
  // A null seed machine is the baseline "Small" and legitimately costs nothing.
  const seedUnpriceable =
    seedMachineUnresolved ||
    seedStorageUnresolved ||
    (seed != null && seed.creditTier != null && seedCredit == null);

  if (seed == null || seedUnpriceable) {
    return {
      totalCents: newTotalCents,
      previousTotalCents: null,
      deltaCents: null,
      rows,
    };
  }

  const previousTotalCents =
    proPlan.base_price_cents +
    (seedMachine?.price_cents ?? 0) +
    (seedStorage?.price_cents ?? 0) +
    (seedCredit?.price_cents ?? 0);

  return {
    totalCents: newTotalCents,
    previousTotalCents,
    deltaCents: newTotalCents - previousTotalCents,
    rows,
  };
}
