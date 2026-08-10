/**
 * Pure diff/recap computation for the Custom Plan configurator — the recap rows
 * and signed price delta the modal renders, kept free of React/JSX/tokens so it
 * can be unit-tested in isolation.
 */

import {
  creditRowLabel,
  formatMonthly,
  storageRowLabel,
} from "@/domains/settings/components/tier-pricing";
import type {
  CreditTierEnum,
  MachineTierEnum,
  ProPlan,
  StorageTierEnum,
} from "@/generated/api/types.gen";
import {
  MACHINE_FLOOR_SIZE,
  SIZE_DESCRIPTION,
  SIZE_LABEL,
} from "@/lib/billing/machine-sizes";

/**
 * Sentinel for the "No extra credits" entry. `CreditChoice` is a string union,
 * so the absence of a tier needs a value to carry through the picker and the
 * diff. `Select` can now express this directly with a `null` option and
 * `onSelectNone`, which would make the sentinel unnecessary.
 */
export const NO_EXTRA_CREDITS = "__none__";
export type CreditChoice = CreditTierEnum | typeof NO_EXTRA_CREDITS;

/** Shared by the credit dropdown's sentinel option and its recap row. */
export const NO_CREDITS_LABEL = "No extra credits";

/**
 * Sentinel for the baseline machine. `MachineTierEnum` names only the paid
 * tiers, so the small machine a package with no tier runs on has no value to
 * carry: it is `null` on the wire. Same note as above: `Select`'s `null`
 * option would remove the need for a stand-in string.
 */
export const BASELINE_MACHINE = "__baseline__";
export type MachineChoice = MachineTierEnum | typeof BASELINE_MACHINE;

/**
 * Matches the shape of the catalog's own machine descriptions ("Medium machine
 * (2.5 vCPU, 5 GiB)"), built from the shared size constants because the
 * baseline has no catalog entry to read one from.
 */
export const BASELINE_MACHINE_LABEL = `${SIZE_LABEL[MACHINE_FLOOR_SIZE]} machine (${SIZE_DESCRIPTION[MACHINE_FLOOR_SIZE]})`;

/**
 * The current Pro tiers used to pre-fill the modal. `machineTier` is `null` for
 * a package with no paid machine tier, which seeds the dropdown to the baseline
 * sentinel rather than leaving it empty.
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

export function computeCustomPlanDiff(input: {
  proPlan: ProPlan;
  seed: CustomPlanSeed | null;
  machineTier: MachineChoice | "";
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

  // The baseline names no catalog tier, so it resolves to a label with no
  // priced entry behind it rather than to a `machineTiers` row.
  const machineIsBaseline = machineTier === BASELINE_MACHINE;
  const selectedMachine = machineIsBaseline
    ? null
    : (machineTiers.find((t) => t.tier === machineTier) ?? null);
  const selectedMachineLabel = machineIsBaseline
    ? BASELINE_MACHINE_LABEL
    : (selectedMachine?.description ?? null);
  const selectedStorage =
    storageTiers.find((t) => t.tier === storageTier) ?? null;
  const selectedCredit =
    creditChoice && creditChoice !== NO_EXTRA_CREDITS
      ? (creditTiers.find((t) => t.tier === creditChoice) ?? null)
      : null;

  const seedMachine =
    seed != null && seed.machineTier != null
      ? (machineTiers.find((t) => t.tier === seed.machineTier) ?? null)
      : null;
  // Normalized so a baseline seed compares against the sentinel the picker
  // holds rather than against the null it arrives as.
  const seedMachineChoice: MachineChoice | null =
    seed != null ? (seed.machineTier ?? BASELINE_MACHINE) : null;
  const seedMachineLabel =
    seed == null
      ? undefined
      : seed.machineTier == null
        ? BASELINE_MACHINE_LABEL
        : seedMachine?.description;
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
      label: `Platform fee: ${formatMonthly(proPlan.base_price_cents)}`,
      changed: false,
    },
  ];

  if (selectedMachineLabel != null) {
    const changed =
      seed != null &&
      !seedMachineUnresolved &&
      seedMachineChoice !== machineTier;
    rows.push({
      key: "machine",
      label: selectedMachineLabel,
      previousLabel: changed ? seedMachineLabel : undefined,
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
      label: storageRowLabel(selectedStorage.storage_gib),
      previousLabel:
        changed && seedStorage != null
          ? storageRowLabel(seedStorage.storage_gib)
          : undefined,
      changed,
    });
  }

  // A concrete bundle the catalog can no longer resolve gets no row at all —
  // "No extra credits" would be affirmatively false for a sub paying for one.
  const selectedCreditLabel =
    creditChoice === NO_EXTRA_CREDITS
      ? NO_CREDITS_LABEL
      : selectedCredit != null
        ? creditRowLabel(selectedCredit.credits_usd)
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
          ? creditRowLabel(seedCredit.credits_usd)
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
