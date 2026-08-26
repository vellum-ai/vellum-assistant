import { Crown, Info, Loader2, Palmtree } from "lucide-react";

import type {
  CreditTier,
  CreditTierEnum,
  MachineTier,
  MachineTierEnum,
  PlanCatalogEntry,
  StorageTier,
  StorageTierEnum,
} from "@/generated/api/types.gen";
import { useTranslation } from "@/i18n";
import { Button } from "@vellumai/design-library/components/button";
import { Card } from "@vellumai/design-library/components/card";
import { Notice } from "@vellumai/design-library/components/notice";
import { Tag } from "@vellumai/design-library/components/tag";
import { Typography } from "@vellumai/design-library/components/typography";

import { minTierPriceCents } from "./adjust-plan-utils";
import { CreditBundlePicker } from "./credit-bundle-picker";
import { PlanFeatureList } from "./plan-feature-list";
import { TierPicker } from "./tier-picker";
import { formatDelta, formatDollars, formatMonthly } from "./tier-pricing";

export interface PlanCardContentProps {
  plan: PlanCatalogEntry;
  isCurrent: boolean;
  onPro: boolean;
  /** The sub's real plan name ("Mighty" / "Custom"); used on the current Pro card. */
  planDisplayName: string;
  /** The sub's real specs plus the catalog rows they don't replace; null until the tier reads settle. */
  currentPlanFeatures: string[] | null;
  cancelAtPeriodEnd: boolean;
  isCanceled: boolean;
  cancelDate: string | null;
  formatGraceDate: (iso: string) => string;
  proTierChangeMode: boolean;
  creditTiersEnabled: boolean;
  creditTiers: CreditTier[];
  displayCreditTier: CreditTierEnum | null;
  onCreditTierChange: (tier: CreditTierEnum | null) => void;
  selectedMachineTier: MachineTierEnum | null;
  selectedStorageTier: StorageTierEnum | null;
  onMachineTierChange: (tier: MachineTierEnum) => void;
  onStorageTierChange: (tier: StorageTierEnum) => void;
  machineTiersForPicker: MachineTier[];
  storageTiersForPicker: StorageTier[];
  currentMachinePrice: number | null;
  currentStoragePrice: number | null;
  currentCreditPriceUnknown: boolean;
  proCurrentTotalCents: number | null;
  proLiveTotalCents: number | null;
  proTotalDelta: number | null;
  onboardingLoading: boolean;
  tierChangePending: boolean;
  machineChanged: boolean;
  storageChanged: boolean;
  creditChanged: boolean;
  tierChangeError: string | null;
  upgradePending: boolean;
  billingActionPending: boolean;
  onUpgrade: () => void;
  onApplyTierChange: () => void;
  onDowngradeClick: () => void;
  onKeepPlan: () => void;
}

export function PlanCardContent({
  plan,
  isCurrent,
  onPro,
  planDisplayName,
  currentPlanFeatures,
  cancelAtPeriodEnd,
  isCanceled,
  cancelDate,
  formatGraceDate: formatDate,
  proTierChangeMode,
  creditTiersEnabled,
  creditTiers,
  displayCreditTier,
  onCreditTierChange,
  selectedMachineTier,
  selectedStorageTier,
  onMachineTierChange,
  onStorageTierChange,
  machineTiersForPicker,
  storageTiersForPicker,
  currentMachinePrice,
  currentStoragePrice,
  currentCreditPriceUnknown,
  proCurrentTotalCents,
  proLiveTotalCents,
  proTotalDelta,
  onboardingLoading,
  tierChangePending,
  machineChanged,
  storageChanged,
  creditChanged,
  tierChangeError,
  upgradePending,
  billingActionPending,
  onUpgrade,
  onApplyTierChange,
  onDowngradeClick,
  onKeepPlan,
}: PlanCardContentProps) {
  const { t } = useTranslation("settings");
  const isProCard = plan.id === "pro";
  const isBaseCard = plan.id === "base";
  const showCancellationOnPro =
    isProCard && onPro && cancelAtPeriodEnd && !isCanceled;
  // Picker is shown for: (a) the Pro card when the user is upgrading from
  // Base, or (b) the Pro card when the current Pro subscriber is in tier-
  // change mode. Derived from existing props — no need for a parent relay.
  const proPickerShown =
    isProCard && (!isCurrent || (isCurrent && proTierChangeMode));
  const showProTierChange = isProCard && isCurrent && proTierChangeMode;
  // Only the card describing a plan the user actually holds goes concrete. To a
  // base user the Pro card is an offer, so it keeps the generic catalog name and
  // capability copy alongside its "From $X/mo" price.
  const showsRealPlan = isProCard && isCurrent;

  return (
    <Card.Root className="flex flex-col bg-[var(--surface-base)]">
      <Card.Body padding="lg" className="max-sm:p-4">
        <div className="flex flex-col gap-4">
          <span
            aria-hidden
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--border-base)] bg-[var(--surface-lift)]"
          >
            {isProCard ? (
              <Crown className="h-5 w-5 text-[var(--content-default)]" />
            ) : (
              <Palmtree className="h-5 w-5 text-[var(--content-default)]" />
            )}
          </span>
          <div className="flex min-h-6 items-center gap-2">
            <Typography
              as="h3"
              variant="title-small"
              data-testid="modal-plan-name"
            >
              {showsRealPlan ? planDisplayName : plan.name}
            </Typography>
            {isCurrent && (
              <Tag tone="positive">{t("planCardContent.current")}</Tag>
            )}
          </div>
          <Typography
            as="p"
            variant="body-small-default"
            className="-mt-2 text-[var(--content-tertiary)]"
          >
            {isBaseCard
              ? t("planCardContent.baseTagline")
              : t("planCardContent.proTagline")}
          </Typography>
          {showCancellationOnPro && cancelDate && (
            <Typography
              as="p"
              variant="body-small-default"
              className="text-[var(--system-mid-strong)]"
              data-testid="modal-cancels-on"
            >
              {t("planCardContent.planEndsOn", {
                date: formatDate(cancelDate),
              })}
            </Typography>
          )}
          <hr className="border-t border-[var(--border-base)]" />
          <div className="flex flex-col gap-1">
            {isBaseCard ? (
              <>
                <Typography as="p" variant="title-medium">
                  {t("planCardContent.free")}
                </Typography>
                <Typography
                  as="p"
                  variant="body-small-default"
                  className="text-[var(--content-tertiary)]"
                >
                  {t("planCardContent.forever")}
                </Typography>
              </>
            ) : isCurrent &&
              !(proPickerShown && proLiveTotalCents != null) &&
              (proCurrentTotalCents == null || currentCreditPriceUnknown) ? (
              onboardingLoading ? (
                <div className="flex items-center gap-2 text-[var(--content-tertiary)]">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <Typography as="span" variant="body-medium-lighter">
                    {t("planCardContent.loadingPlan")}
                  </Typography>
                </div>
              ) : (
                <Typography
                  as="p"
                  variant="body-medium-lighter"
                  className="text-[var(--content-tertiary)]"
                  data-testid="modal-pro-price-unavailable"
                >
                  {t("planCardContent.pricingUnavailable")}
                </Typography>
              )
            ) : (
              <>
                <div className="flex items-center gap-1">
                  <Typography
                    as="p"
                    variant="title-medium"
                    data-testid="modal-pro-price"
                  >
                    {proPickerShown && proLiveTotalCents != null ? (
                      <>
                        {formatMonthly(proLiveTotalCents)}
                        {proTotalDelta != null && proTotalDelta !== 0 && (
                          <span className="ml-1 text-[var(--content-tertiary)]">
                            ({formatDelta(proTotalDelta)})
                          </span>
                        )}
                      </>
                    ) : proCurrentTotalCents != null ? (
                      t("planCardContent.currentlyPrice", {
                        price: formatMonthly(proCurrentTotalCents),
                      })
                    ) : plan.id === "pro" ? (
                      t("planCardContent.fromPrice", {
                        price: formatMonthly(
                          plan.base_price_cents +
                            minTierPriceCents(plan.machine_tiers) +
                            minTierPriceCents(plan.storage_tiers),
                        ),
                      })
                    ) : null}
                  </Typography>
                  {proPickerShown &&
                    proTotalDelta != null &&
                    proTotalDelta !== 0 && (
                      <span
                        title={t("planCardContent.subscriptionChangeTitle", {
                          from: formatMonthly(proCurrentTotalCents!),
                          to: formatMonthly(proLiveTotalCents!),
                        })}
                      >
                        <Info className="h-3 w-3 text-[var(--content-tertiary)]" />
                      </span>
                    )}
                </div>
                {plan.id === "pro" && (
                  <Typography
                    as="p"
                    variant="body-small-default"
                    className="text-[var(--content-tertiary)]"
                    data-testid="modal-pro-base-fee"
                  >
                    {t("planCardContent.baseFee", {
                      amount: formatDollars(plan.base_price_cents),
                    })}
                  </Typography>
                )}
              </>
            )}
          </div>
          <PlanFeatureList
            features={
              showsRealPlan && currentPlanFeatures
                ? currentPlanFeatures
                : plan.included_features
            }
            variant="checklist"
          />
          {isProCard && !creditTiersEnabled && (
            <Typography
              as="p"
              variant="body-small-default"
              className="text-[var(--content-tertiary)]"
              data-testid="modal-credits-not-included"
            >
              {t("planCardContent.creditsNotIncluded")}
            </Typography>
          )}
        </div>
        <div className="mt-4 flex flex-1 flex-col justify-end gap-4">
          {!isCurrent && isProCard && (
            <>
              <hr className="border-t border-[var(--border-base)]" />
              {creditTiersEnabled && (
                <CreditBundlePicker
                  creditTiers={creditTiers}
                  selectedCreditTier={displayCreditTier}
                  onCreditTierChange={onCreditTierChange}
                  disabled={upgradePending}
                />
              )}
              <TierPicker
                machineTiers={machineTiersForPicker}
                storageTiers={storageTiersForPicker}
                selectedMachineTier={selectedMachineTier}
                selectedStorageTier={selectedStorageTier}
                onMachineTierChange={onMachineTierChange}
                onStorageTierChange={onStorageTierChange}
              />
              <Button
                variant="primary"
                className="w-full"
                onClick={onUpgrade}
                disabled={
                  upgradePending || !selectedMachineTier || !selectedStorageTier
                }
                data-testid="modal-upgrade-to-pro-button"
              >
                {t("planCardContent.upgradeToPro")}
              </Button>
            </>
          )}
          {showProTierChange &&
            (onboardingLoading ? (
              <div className="flex items-center gap-2 text-[var(--content-tertiary)]">
                <Loader2 className="h-4 w-4 animate-spin" />
                <Typography as="span" variant="body-medium-lighter">
                  {t("planCardContent.loadingPlan")}
                </Typography>
              </div>
            ) : (
              <>
                <hr className="border-t border-[var(--border-base)]" />
                {creditTiersEnabled && (
                  <CreditBundlePicker
                    creditTiers={creditTiers}
                    selectedCreditTier={displayCreditTier}
                    onCreditTierChange={onCreditTierChange}
                    disabled={tierChangePending}
                  />
                )}
                <TierPicker
                  machineTiers={machineTiersForPicker}
                  storageTiers={storageTiersForPicker}
                  selectedMachineTier={selectedMachineTier}
                  selectedStorageTier={selectedStorageTier}
                  onMachineTierChange={onMachineTierChange}
                  onStorageTierChange={onStorageTierChange}
                  currentMachinePriceCents={currentMachinePrice}
                  currentStoragePriceCents={currentStoragePrice}
                />
                {tierChangeError && (
                  <Notice tone="error">{tierChangeError}</Notice>
                )}
                <Button
                  variant="primary"
                  className="w-full"
                  onClick={onApplyTierChange}
                  disabled={
                    tierChangePending ||
                    (!machineChanged && !storageChanged && !creditChanged)
                  }
                  data-testid="modal-change-tier-button"
                >
                  {t("planCardContent.updatePlan")}
                </Button>
              </>
            ))}
          {!isCurrent && isBaseCard && onPro && !cancelAtPeriodEnd && (
            <>
              <hr className="border-t border-[var(--border-base)]" />
              <Button
                variant="outlined"
                className="w-full"
                onClick={onDowngradeClick}
                disabled={billingActionPending}
                data-testid="modal-downgrade-to-base-button"
              >
                {t("planCardContent.downgradeToBase")}
              </Button>
            </>
          )}
          {showCancellationOnPro && (
            <>
              <hr className="border-t border-[var(--border-base)]" />
              <Button
                variant="outlined"
                className="w-full"
                onClick={onKeepPlan}
                disabled={billingActionPending}
                data-testid="modal-keep-plan-button"
              >
                {t("planCardContent.keepPlan")}
              </Button>
            </>
          )}
        </div>
      </Card.Body>
    </Card.Root>
  );
}
