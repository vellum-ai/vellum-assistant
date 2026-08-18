import {
  CircleCheck,
  Coins,
  Computer,
  HardDrive,
  SlidersHorizontal,
} from "lucide-react";
import { useMemo, useState } from "react";

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
  StorageTier,
  StorageTierEnum,
} from "@/generated/api/types.gen";
import { useTranslation } from "@/i18n";
import { handleNativeAnchorClick } from "@/utils/native-anchor";
import { Button } from "@vellumai/design-library/components/button";
import {
  Select,
  type SelectOption,
} from "@vellumai/design-library/components/select";
import { Modal } from "@vellumai/design-library/components/modal";

import {
  BASELINE_MACHINE,
  BASELINE_MACHINE_LABEL,
  type CreditChoice,
  type CustomPlanSeed,
  type MachineChoice,
  computeCustomPlanDiff,
  NO_CREDITS_LABEL,
  NO_EXTRA_CREDITS,
} from "./custom-plan-diff";
import {
  CREDIT_DOCS_URL,
  MACHINE_DOCS_URL,
  STORAGE_DOCS_URL,
} from "./docs-links";

export type { CustomPlanSeed };

export interface CustomPlanSelection {
  /** `null` is the baseline machine: the absence of a paid tier. */
  machineTier: MachineTierEnum | null;
  storageTier: StorageTierEnum;
  /** `null` is the explicit "No extra credits" choice. */
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
   * plan. Pre-fills every dimension; the seeded default is a no-op, so Continue
   * stays disabled until a dimension changes, and an unrelated edit can't force
   * re-picking — and dropping — a tier the user still holds. A null
   * `machineTier` is the baseline machine, seeded as a disabled option so the
   * picker names the machine the sub runs on rather than showing its
   * placeholder. Leave null/undefined for base checkout, which starts every
   * dimension empty.
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
 * A picker's caption and its docs link. The three links read "Learn more"
 * alike, so each takes an `aria-label` naming the dimension it explains.
 * The click routes through the native opener because the iOS WKWebView shell
 * cannot open a `target="_blank"` anchor on its own; the `href` stays for
 * web and Electron.
 */
function PickerLabel({
  label,
  docsUrl,
  docsLabel,
  learnMore,
}: {
  label: string;
  docsUrl: string;
  docsLabel: string;
  learnMore: string;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[11px] font-medium text-[var(--content-secondary)]">
        {label}
      </span>
      <a
        href={docsUrl}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={docsLabel}
        onClick={(e) => handleNativeAnchorClick(e, docsUrl)}
        className="text-[11px] font-medium text-[var(--content-tertiary)] underline hover:text-[var(--content-default)]"
      >
        {learnMore}
      </a>
    </div>
  );
}

/**
 * "Create a custom plan" configurator opened from the Custom Plan row of the
 * View Plans takeover. Always light regardless of the app theme, matching the
 * white dialog over the dark takeover in the pricing mocks. The three pickers
 * render as dropdowns and start unselected for base checkout (or seeded from
 * the current plan for a Pro reconfigure); Continue stays disabled until every
 * dimension has an explicit choice ("No extra credits" counts) and, for a Pro
 * reconfigure, until at least one dimension differs from the seeded plan.
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
  const { t } = useTranslation("settings");

  // A Pro reconfigure seeds the current tiers so the default is a no-op; base
  // checkout passes none and leaves every dimension empty. A baseline machine
  // (null) seeds the sentinel, mirroring how a null credit tier seeds
  // "No extra credits".
  const seed = open ? (initialSelection ?? null) : null;
  const [machineTier, setMachineTier] = useState<MachineChoice | "">(() =>
    seed ? (seed.machineTier ?? BASELINE_MACHINE) : "",
  );
  const [storageTier, setStorageTier] = useState<StorageTierEnum | "">(
    () => seed?.storageTier ?? "",
  );
  const [creditChoice, setCreditChoice] = useState<CreditChoice | "">(() =>
    seed ? (seed.creditTier ?? NO_EXTRA_CREDITS) : "",
  );

  // Seeding during render rather than from an effect: an effect-seeded modal
  // paints one frame of empty pickers against a non-empty seed, flashing a
  // full-magnitude negative delta and a recap collapsed to the base row.
  const [seededFrom, setSeededFrom] = useState({ open, initialSelection });
  if (
    seededFrom.open !== open ||
    seededFrom.initialSelection !== initialSelection
  ) {
    setSeededFrom({ open, initialSelection });
    setMachineTier(seed ? (seed.machineTier ?? BASELINE_MACHINE) : "");
    setStorageTier(seed?.storageTier ?? "");
    setCreditChoice(seed ? (seed.creditTier ?? NO_EXTRA_CREDITS) : "");
  }

  const machineTiers = proPlan.machine_tiers;
  // Legacy tiers stay in the catalog only for existing subscribers, so a new
  // configuration must not offer them — but a subscriber seeded onto one keeps
  // it, so changing another dimension isn't a one-way door out of the tier they
  // pay for.
  const offerableStorageTiers = useMemo(
    () =>
      proPlan.storage_tiers.filter(
        (t) => !t.legacy || t.tier === initialSelection?.storageTier,
      ),
    [proPlan.storage_tiers, initialSelection?.storageTier],
  );
  const allCreditTiers = proPlan.credit_tiers ?? [];
  // The same legacy split for the selectable credit options; the full list is
  // kept so a held legacy bundle can still be priced and shown (below).
  const selectableCreditTiers = useMemo(
    () => (proPlan.credit_tiers ?? []).filter((t) => !t.legacy),
    [proPlan.credit_tiers],
  );

  // Only the seeded legacy tier escapes the legacy disable — it is the current
  // choice, so it has to stay re-selectable.
  const storageOptionDisabled = (t: StorageTier) =>
    isTierDisabled(t) ||
    (t.legacy && t.tier !== initialSelection?.storageTier) ||
    (currentStorageGib != null && t.storage_gib < currentStorageGib);

  // The baseline is not a tier the catalog offers, so it is listed only for the
  // sub already on it: present so the picker can state what they run on, and
  // disabled because moving back down to it is not a change this modal makes.
  // It carries no price suffix, since it adds nothing to the total.
  const seededBaselineMachine =
    initialSelection != null && initialSelection.machineTier == null;
  const baselineMachineOption: SelectOption<MachineChoice> = {
    value: BASELINE_MACHINE,
    label: BASELINE_MACHINE_LABEL,
    icon: <Computer className="h-4 w-4" aria-hidden />,
    disabled: true,
  };
  const machineOptions: SelectOption<MachineChoice>[] = [
    ...(seededBaselineMachine ? [baselineMachineOption] : []),
    ...machineTiers.map((t) => ({
      value: t.tier as MachineChoice,
      label: t.description,
      icon: <Computer className="h-4 w-4" aria-hidden />,
      suffix: priceSuffix(t.price_cents),
      disabled: isTierDisabled(t),
    })),
  ];
  const storageOptions: SelectOption<StorageTierEnum>[] =
    offerableStorageTiers.map((t) => ({
      value: t.tier as StorageTierEnum,
      label: t.label,
      icon: <HardDrive className="h-4 w-4" aria-hidden />,
      suffix: priceSuffix(t.price_cents),
      disabled: storageOptionDisabled(t),
    }));
  // Resolve the current credit choice against the full catalog (legacy
  // included) so a held bundle is recognised rather than read as unset.
  const selectedCredit =
    creditChoice && creditChoice !== NO_EXTRA_CREDITS
      ? (allCreditTiers.find((t) => t.tier === creditChoice) ?? null)
      : null;
  // A held legacy bundle isn't offered to a new config, but when it's the
  // current selection it's appended disabled so the dropdown still shows it.
  const heldLegacyCredit = selectedCredit?.legacy ? selectedCredit : null;

  const creditOptions: SelectOption<CreditChoice>[] = [
    {
      value: NO_EXTRA_CREDITS,
      label: NO_CREDITS_LABEL,
      icon: <Coins className="h-4 w-4" aria-hidden />,
    },
    ...selectableCreditTiers.map((t) => ({
      value: t.tier as CreditTierEnum,
      label: t.label,
      icon: <Coins className="h-4 w-4" aria-hidden />,
      suffix: priceSuffix(t.price_cents),
    })),
    ...(heldLegacyCredit
      ? [
          {
            value: heldLegacyCredit.tier as CreditTierEnum,
            label: heldLegacyCredit.label,
            icon: <Coins className="h-4 w-4" aria-hidden />,
            suffix: priceSuffix(heldLegacyCredit.price_cents),
            disabled: true,
          },
        ]
      : []),
  ];

  const machineIsBaseline = machineTier === BASELINE_MACHINE;
  const selectedMachine = machineIsBaseline
    ? null
    : (machineTiers.find((t) => t.tier === machineTier) ?? null);
  // The submittable machine, as the tier the API takes: `null` IS the baseline,
  // so the choice is wrapped rather than reported as a bare tier. The baseline
  // passes through only for the sub it was seeded from, matching the storage
  // and credit guards below. The dropdown renders it disabled for anyone else,
  // and a disabled choice must not be submittable.
  const submittableMachine: { tier: MachineTierEnum | null } | null =
    machineIsBaseline
      ? seededBaselineMachine
        ? { tier: null }
        : null
      : selectedMachine != null
        ? { tier: selectedMachine.tier as MachineTierEnum }
        : null;

  // A tier the dropdown renders disabled would be rejected server-side, and a
  // plans refetch can disable the standing selection mid-modal. The seeded
  // values pass through regardless — re-sending what the sub holds is a no-op.
  const storageIsSeeded =
    storageTier !== "" && storageTier === initialSelection?.storageTier;
  const submittableStorage =
    offerableStorageTiers.find(
      (t) =>
        t.tier === storageTier &&
        (storageIsSeeded || !storageOptionDisabled(t)),
    ) ?? null;
  const creditIsSubmittable =
    creditChoice === NO_EXTRA_CREDITS ||
    creditChoice === initialSelection?.creditTier ||
    selectableCreditTiers.some((t) => t.tier === creditChoice);
  const submittableCredit: CreditChoice | null =
    creditChoice !== "" && creditIsSubmittable ? creditChoice : null;

  const complete =
    submittableMachine != null &&
    submittableStorage != null &&
    submittableCredit != null;

  // Reconfiguring an existing Pro plan opens seeded to the current tiers, so
  // submitting them unchanged is a no-op — hold Continue disabled until at least
  // one dimension differs from the seed. Base checkout has no seed, so a
  // complete selection is always submittable. Compared against the raw seed
  // values (not the priced diff) so a seed tier the catalog dropped still reads
  // as changed once the user picks a live replacement.
  const matchesSeed =
    initialSelection != null &&
    machineTier === (initialSelection.machineTier ?? BASELINE_MACHINE) &&
    storageTier === initialSelection.storageTier &&
    creditChoice === (initialSelection.creditTier ?? NO_EXTRA_CREDITS);

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
    if (!complete || matchesSeed || pending) {
      return;
    }
    onContinue({
      machineTier: submittableMachine.tier,
      storageTier: submittableStorage.tier as StorageTierEnum,
      creditTier:
        submittableCredit === NO_EXTRA_CREDITS ? null : submittableCredit,
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
                    {t("customPlanModal.title")}
                  </Modal.Title>
                  <Modal.Description className="mt-0 text-[14px] font-medium leading-[18px] text-[var(--content-tertiary)]">
                    {t("customPlanModal.subtitle")}
                  </Modal.Description>
                </div>
              </div>

              <div className="flex flex-col gap-1">
                <PickerLabel
                  label={t("customPlanModal.machineSizeLabel")}
                  docsUrl={MACHINE_DOCS_URL}
                  docsLabel={t("customPlanModal.machineSizeDocsAriaLabel")}
                  learnMore={t("customPlanModal.learnMore")}
                />
                <Select<MachineChoice>
                  aria-label={t("customPlanModal.machineSizeAriaLabel")}
                  placeholder={t("customPlanModal.machineSizePlaceholder")}
                  value={machineTier}
                  onChange={setMachineTier}
                  options={machineOptions}
                />
              </div>

              <div className="flex flex-col gap-1">
                <PickerLabel
                  label={t("customPlanModal.storageLabel")}
                  docsUrl={STORAGE_DOCS_URL}
                  docsLabel={t("customPlanModal.storageDocsAriaLabel")}
                  learnMore={t("customPlanModal.learnMore")}
                />
                <Select<StorageTierEnum>
                  aria-label={t("customPlanModal.storageAriaLabel")}
                  placeholder={t("customPlanModal.storagePlaceholder")}
                  value={storageTier}
                  onChange={setStorageTier}
                  options={storageOptions}
                />
              </div>

              <div className="flex flex-col gap-1">
                <PickerLabel
                  label={t("customPlanModal.creditsLabel")}
                  docsUrl={CREDIT_DOCS_URL}
                  docsLabel={t("customPlanModal.creditsDocsAriaLabel")}
                  learnMore={t("customPlanModal.learnMore")}
                />
                <Select<CreditChoice>
                  aria-label={t("customPlanModal.creditBundleAriaLabel")}
                  placeholder={t("customPlanModal.creditBundlePlaceholder")}
                  value={creditChoice}
                  onChange={setCreditChoice}
                  options={creditOptions}
                />
              </div>
            </div>

            <div className="flex min-w-0 flex-1 flex-col gap-16 md:pt-[5px]">
              <span className="text-[16px] font-medium text-[var(--content-emphasised)]">
                {t("customPlanModal.recap")}
              </span>

              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-1">
                  <span className="text-[24px] font-medium text-[var(--content-default)]">
                    {formatMonthly(diff.totalCents)}
                  </span>
                  {diff.deltaCents != null &&
                    diff.deltaCents !== 0 &&
                    diff.previousTotalCents != null && (
                      <span
                        className={`text-[12px] font-medium ${diff.deltaCents > 0 ? "text-[var(--system-positive-strong)]" : "text-[var(--system-negative-strong)]"}`}
                      >
                        {t("customPlanModal.comparedToPrevious", {
                          delta: formatDelta(diff.deltaCents),
                          previous: formatDollars(diff.previousTotalCents),
                        })}
                      </span>
                    )}
                  <span className="text-[11px] font-medium text-[var(--content-tertiary)]">
                    {t("customPlanModal.totalBilledMonthly")}
                  </span>
                </div>

                <div className="h-px w-full bg-[var(--border-hover)]" />

                <span className="text-[12px] font-medium text-[var(--content-tertiary)]">
                  {t("customPlanModal.yourSelection")}
                </span>

                <ul className="flex flex-col gap-2">
                  {diff.rows.map((row) => (
                    <li key={row.key} className="flex flex-col gap-2">
                      {row.previousLabel != null && (
                        // The rule is drawn across the row rather than set as a
                        // text decoration because the design strikes the icon too.
                        <div className="relative flex w-fit items-start gap-2">
                          <CircleCheck
                            className="mt-0.5 h-4 w-4 shrink-0 text-[var(--content-disabled)]"
                            aria-hidden
                          />
                          <s className="text-[14px] font-medium leading-[18px] text-[var(--content-disabled)] no-underline">
                            {row.previousLabel}
                          </s>
                          <span
                            aria-hidden
                            className="pointer-events-none absolute -left-1 right-0 top-[9px] h-px bg-[var(--content-disabled)]"
                          />
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
                  disabled={!complete || matchesSeed || pending}
                  onClick={handleContinue}
                >
                  {t("customPlanModal.continue")}
                </Button>
                <Button
                  variant="ghost"
                  fullWidth
                  disabled={pending}
                  onClick={onClose}
                >
                  {t("customPlanModal.cancel")}
                </Button>
              </div>
            </div>
          </div>
        </Modal.Body>
      </Modal.Content>
    </Modal.Root>
  );
}
