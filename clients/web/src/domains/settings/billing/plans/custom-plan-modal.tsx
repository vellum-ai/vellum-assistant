import {
  CircleCheck,
  Coins,
  Computer,
  HardDrive,
  SlidersHorizontal,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { isTierDisabled } from "@/domains/settings/components/tier-picker";
import {
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

/**
 * Sentinel option value for the "No extra credits" entry — the Dropdown is
 * generic over `T extends string`, so it cannot carry a real `null`. Mapped
 * to `null` at the `onContinue` boundary (mirrors `credit-bundle-picker`).
 */
const NO_EXTRA_CREDITS = "__none__";

type CreditChoice = CreditTierEnum | typeof NO_EXTRA_CREDITS;

export interface CustomPlanSelection {
  machineTier: MachineTierEnum;
  storageTier: StorageTierEnum;
  /** `null` is the explicit "No extra credits" choice. */
  creditTier: CreditTierEnum | null;
}

export interface CustomPlanModalProps {
  open: boolean;
  /** Pro catalog supplying the machine/storage/credit tiers and base price. */
  proPlan: ProPlan;
  /** A checkout is in flight — hold Continue disabled until it resolves. */
  pending: boolean;
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
 * render as dropdowns and start unselected; Continue stays disabled until
 * every dimension has an explicit choice ("No extra credits" counts).
 */
export function CustomPlanModal({
  open,
  proPlan,
  pending,
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
    }
  }, [open]);

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
      disabled: isTierDisabled(t),
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

  // The base platform fee is always charged, so it permanently leads the
  // recap — the total above then reconciles with the visible rows even
  // before anything is selected.
  const selectionRows = [
    `Pro base plan — ${formatMonthly(proPlan.base_price_cents)}`,
    selectedMachine?.description,
    selectedStorage ? `${selectedStorage.storage_gib} GB storage` : null,
    creditChoice === NO_EXTRA_CREDITS
      ? "No extra credits"
      : selectedCredit
        ? `${formatDollars(selectedCredit.credits_usd * 100)} of bundled credits`
        : null,
  ].filter((row): row is string => row != null);

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
        <Modal.Body className="p-6">
          <div className="flex flex-col gap-8 md:flex-row md:gap-12">
            <div className="flex min-w-0 flex-col gap-8 md:w-[440px] md:shrink-0">
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

              <div className="flex flex-col gap-2">
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

              <div className="flex flex-col gap-2">
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

              <div className="flex flex-col gap-2">
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

            <div className="flex min-w-0 flex-1 flex-col gap-5 md:pt-[3px]">
              <span className="text-[16px] font-medium text-[var(--content-emphasised)]">
                Recap
              </span>

              <div className="flex flex-col gap-1">
                <span className="text-[24px] font-medium text-[var(--content-default)]">
                  {formatMonthly(totalCents)}
                </span>
                <span className="text-[11px] font-medium text-[var(--content-tertiary)]">
                  Total
                </span>
              </div>

              <div className="h-px w-full bg-[var(--border-hover)]" />

              <span className="text-[12px] font-medium text-[var(--content-tertiary)]">
                Your selection:
              </span>

              <ul className="flex flex-col gap-2">
                {selectionRows.map((row) => (
                  <li key={row} className="flex items-start gap-2">
                    <CircleCheck
                      className="mt-0.5 h-4 w-4 shrink-0 text-[var(--content-secondary)]"
                      aria-hidden
                    />
                    <span className="text-[14px] font-medium leading-[18px] text-[var(--content-secondary)]">
                      {row}
                    </span>
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
        </Modal.Body>
      </Modal.Content>
    </Modal.Root>
  );
}
