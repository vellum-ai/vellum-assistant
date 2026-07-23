import {
  Circle,
  CircleCheck,
  Coins,
  Computer,
  HardDrive,
  SlidersHorizontal,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { isTierDisabled } from "@/domains/settings/components/tier-picker";
import {
  formatDelta,
  formatDollars,
  formatMonthly,
} from "@/domains/settings/components/tier-pricing";
import type {
  CreditTierEnum,
  MachineTierEnum,
  ProPlan,
  StorageTierEnum,
} from "@/generated/api/types.gen";
import { Button } from "@vellumai/design-library/components/button";
import {
  Dropdown,
  type DropdownOption,
} from "@vellumai/design-library/components/dropdown";
import { Modal } from "@vellumai/design-library/components/modal";

import {
  type CreditChoice,
  computeCustomPlanDiff,
  NO_EXTRA_CREDITS,
} from "./custom-plan-diff";

export interface CustomPlanSelection {
  machineTier: MachineTierEnum;
  storageTier: StorageTierEnum;
  /** `null` is the explicit "No extra credits" choice. */
  creditTier: CreditTierEnum | null;
}

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

export interface CustomPlanModalProps {
  open: boolean;
  /** Pro catalog supplying the machine/storage/credit tiers and base price. */
  proPlan: ProPlan;
  /** A checkout or tier change is in flight — hold Continue disabled. */
  pending: boolean;
  /**
   * The Pro subscriber's current storage size, when reconfiguring an existing
   * Pro plan. Storage is upgrade-only for Pro (the change-storage-tier endpoint
   * rejects downgrades), so tiers below this size render disabled. Leave
   * null/undefined for the base checkout path, where every tier is selectable.
   */
  currentStorageGib?: number | null;
  /**
   * The Pro subscriber's current tiers, when reconfiguring an existing Pro
   * plan. Pre-fills every dimension so the default is a no-op and an unrelated
   * edit can't force re-picking — and dropping — a tier the user still holds.
   * A null `machineTier` (baseline "Small") seeds storage/credit and leaves the
   * machine picker empty. Leave null/undefined for base checkout, which starts
   * every dimension empty.
   */
  initialSelection?: CustomPlanSeed | null;
  onClose: () => void;
  onContinue: (selection: CustomPlanSelection) => void;
}

function priceSuffix(cents: number) {
  return (
    <span className="text-[12px] font-medium text-[var(--content-disabled)]">
      +{formatMonthly(cents)}
    </span>
  );
}

/**
 * "Create a custom plan" configurator opened from the Custom Plan row of the
 * View Plans takeover. Always light regardless of the app theme, matching the
 * white dialog over the dark takeover in the pricing mocks. The three pickers
 * render as dropdowns and start unselected for base checkout (or seeded from
 * the current plan for a Pro reconfigure); Continue stays disabled until every
 * dimension has an explicit choice ("No extra credits" counts).
 */
export function CustomPlanModal({
  open,
  proPlan,
  pending,
  currentStorageGib,
  initialSelection,
  onClose,
  onContinue,
}: CustomPlanModalProps) {
  const [machineTier, setMachineTier] = useState<MachineTierEnum | "">("");
  const [storageTier, setStorageTier] = useState<StorageTierEnum | "">("");
  const [creditChoice, setCreditChoice] = useState<CreditChoice | "">("");

  useEffect(() => {
    if (!open) {
      setMachineTier("");
      setStorageTier("");
      setCreditChoice("");
      return;
    }
    // Reopening for a Pro reconfigure seeds the current tiers so the default is
    // a no-op; base checkout passes none and leaves every dimension empty. A
    // baseline machine (null) has no tier to seed, so its picker starts empty.
    if (initialSelection) {
      setMachineTier(initialSelection.machineTier ?? "");
      setStorageTier(initialSelection.storageTier);
      setCreditChoice(initialSelection.creditTier ?? NO_EXTRA_CREDITS);
    }
  }, [open, initialSelection]);

  const machineTiers = proPlan.machine_tiers;
  // Legacy tiers stay in the catalog only for existing subscribers; a new
  // custom configuration must not offer them.
  const storageTiers = useMemo(
    () => proPlan.storage_tiers.filter((t) => !t.legacy),
    [proPlan.storage_tiers],
  );
  const creditTiers = proPlan.credit_tiers ?? [];

  const machineOptions: DropdownOption<MachineTierEnum>[] = machineTiers.map(
    (t) => ({
      value: t.tier as MachineTierEnum,
      label: t.description,
      icon: <Computer className="h-4 w-4" aria-hidden />,
      suffix: priceSuffix(t.price_cents),
      disabled: isTierDisabled(t),
    }),
  );
  const storageOptions: DropdownOption<StorageTierEnum>[] = storageTiers.map(
    (t) => ({
      value: t.tier as StorageTierEnum,
      label: t.label,
      icon: <HardDrive className="h-4 w-4" aria-hidden />,
      suffix: priceSuffix(t.price_cents),
      disabled:
        isTierDisabled(t) ||
        (currentStorageGib != null && t.storage_gib < currentStorageGib),
    }),
  );
  const creditOptions: DropdownOption<CreditChoice>[] = [
    {
      value: NO_EXTRA_CREDITS,
      label: "No extra credits",
      icon: <Coins className="h-4 w-4" aria-hidden />,
    },
    ...creditTiers.map((t) => ({
      value: t.tier as CreditTierEnum,
      label: t.label,
      icon: <Coins className="h-4 w-4" aria-hidden />,
      suffix: priceSuffix(t.price_cents),
    })),
  ];

  const selectedMachine =
    machineTiers.find((t) => t.tier === machineTier) ?? null;
  const selectedStorage =
    storageTiers.find((t) => t.tier === storageTier) ?? null;
  const selectedCredit =
    creditChoice && creditChoice !== NO_EXTRA_CREDITS
      ? (creditTiers.find((t) => t.tier === creditChoice) ?? null)
      : null;

  const complete =
    selectedMachine != null && selectedStorage != null && creditChoice !== "";
  const totalCents =
    proPlan.base_price_cents +
    (selectedMachine?.price_cents ?? 0) +
    (selectedStorage?.price_cents ?? 0) +
    (selectedCredit?.price_cents ?? 0);

  // Recap rows + signed price delta vs. the current plan (seed).
  const diff = useMemo(
    () =>
      computeCustomPlanDiff({
        proPlan,
        seed: initialSelection ?? null,
        machineTier,
        storageTier,
        creditChoice,
      }),
    [proPlan, initialSelection, machineTier, storageTier, creditChoice],
  );

  const handleContinue = () => {
    if (!selectedMachine || !selectedStorage || creditChoice === "" || pending) {
      return;
    }
    onContinue({
      machineTier: selectedMachine.tier as MachineTierEnum,
      storageTier: selectedStorage.tier as StorageTierEnum,
      creditTier: creditChoice === NO_EXTRA_CREDITS ? null : creditChoice,
    });
  };

  return (
    <Modal.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
    >
      {/* 608px is the design's dialog height; min() keeps short windows from
          forcing the dialog past the viewport, since min-height would beat
          the base max-height. */}
      <Modal.Content
        size="lg"
        data-theme="light"
        hideCloseButton
        overlayClassName="backdrop-blur-[2px]"
        className="max-w-[820px] md:min-h-[min(608px,calc(100vh-4rem))]"
      >
        <Modal.Body className="p-4">
          <div className="flex flex-col gap-8 md:flex-row md:gap-12">
            <div className="flex min-w-0 flex-col gap-6 md:flex-1">
              <div className="flex items-center gap-3">
                <div className="flex shrink-0 items-center justify-center rounded-xl bg-[var(--surface-active)] p-[14px]">
                  <SlidersHorizontal
                    className="h-6 w-6 text-[var(--content-emphasised)]"
                    aria-hidden
                  />
                </div>
                <div className="flex min-w-0 flex-col gap-1">
                  <Modal.Title className="text-[16px] font-medium text-[var(--content-emphasised)]">
                    Create a custom plan
                  </Modal.Title>
                  <Modal.Description className="mt-0 text-[14px] font-medium leading-[18px] text-[var(--content-tertiary)]">
                    Just better.
                  </Modal.Description>
                </div>
              </div>

              <div className="flex flex-col gap-1">
                <span className="text-[11px] font-medium text-[var(--content-secondary)]">
                  Select a machine size:
                </span>
                <Dropdown<MachineTierEnum>
                  aria-label="Machine size"
                  placeholder="Select a machine size"
                  value={machineTier}
                  onChange={setMachineTier}
                  options={machineOptions}
                />
              </div>

              <div className="flex flex-col gap-1">
                <span className="text-[11px] font-medium text-[var(--content-secondary)]">
                  Select storage:
                </span>
                <Dropdown<StorageTierEnum>
                  aria-label="Storage"
                  placeholder="Select storage"
                  value={storageTier}
                  onChange={setStorageTier}
                  options={storageOptions}
                />
              </div>

              <div className="flex flex-col gap-1">
                <span className="text-[11px] font-medium text-[var(--content-secondary)]">
                  Bundle some credits:
                </span>
                <Dropdown<CreditChoice>
                  aria-label="Credit bundle"
                  placeholder="Select a credit bundle"
                  value={creditChoice}
                  onChange={setCreditChoice}
                  options={creditOptions}
                />
              </div>
            </div>

            <div className="flex min-w-0 flex-1 flex-col gap-16 md:pt-[5px]">
              <span className="text-[16px] font-medium text-[var(--content-emphasised)]">
                Recap
              </span>

              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-1">
                  <span className="text-[24px] font-medium text-[var(--content-default)]">
                    {formatMonthly(totalCents)}
                  </span>
                  {diff.deltaCents != null &&
                    diff.deltaCents !== 0 &&
                    diff.previousTotalCents != null && (
                      <span
                        className={`text-[12px] font-medium ${diff.deltaCents > 0 ? "text-[var(--system-positive-strong)]" : "text-[var(--system-negative-strong)]"}`}
                      >
                        {formatDelta(diff.deltaCents)} compared to previous (
                        {formatDollars(diff.previousTotalCents)})
                      </span>
                    )}
                  <span className="text-[11px] font-medium text-[var(--content-tertiary)]">
                    Total
                  </span>
                </div>

                <div className="h-px w-full bg-[var(--border-hover)]" />

                <span className="text-[12px] font-medium text-[var(--content-tertiary)]">
                  Your selection:
                </span>

                <ul className="flex flex-col gap-2">
                  {diff.rows.map((row) => (
                    <li key={row.key} className="flex flex-col gap-2">
                      {row.previousLabel != null && (
                        <div className="flex items-start gap-2">
                          <Circle
                            className="mt-0.5 h-4 w-4 shrink-0 text-[var(--content-disabled)]"
                            aria-hidden
                          />
                          <span className="text-[14px] font-medium leading-[18px] text-[var(--content-disabled)] line-through">
                            {row.previousLabel}
                          </span>
                        </div>
                      )}
                      <div className="flex items-start gap-2">
                        <CircleCheck
                          className={`mt-0.5 h-4 w-4 shrink-0 ${row.changed ? "text-[var(--system-positive-strong)]" : "text-[var(--content-secondary)]"}`}
                          aria-hidden
                        />
                        <span className="text-[14px] font-medium leading-[18px] text-[var(--content-secondary)]">
                          {row.label}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>

                <Button
                  variant="primary"
                  fullWidth
                  disabled={!complete || pending}
                  onClick={handleContinue}
                >
                  Continue
                </Button>
                <Button
                  variant="ghost"
                  fullWidth
                  disabled={pending}
                  onClick={onClose}
                >
                  Cancel
                </Button>
              </div>
            </div>
          </div>
        </Modal.Body>
      </Modal.Content>
    </Modal.Root>
  );
}
