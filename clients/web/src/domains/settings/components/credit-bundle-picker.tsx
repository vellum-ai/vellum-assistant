import { Info } from "lucide-react";
import { useMemo } from "react";

import type { CreditTier, CreditTierEnum } from "@/generated/api/types.gen";
import { t, useTranslation } from "@/i18n";
import {
  Select,
  type SelectOption,
} from "@vellumai/design-library/components/select";
import { Typography } from "@vellumai/design-library/components/typography";

import { formatMonthly } from "./tier-pricing";

/**
 * The catalog types `CreditTier.tier` as `string` while the subscription
 * types the same concept as `CreditTierEnum` (see `types.gen.ts`), so the
 * option values cannot be narrower than what the API returns.
 */
type CreditOptionValue = string;

/** "{label} - {price}" for a catalog tier. */
export function formatBundleOptionLabel(tier: CreditTier): string {
  return t("settings:creditBundlePicker.optionLabel", {
    label: tier.label,
    price: formatMonthly(tier.price_cents),
  });
}

export interface CreditBundlePickerProps {
  creditTiers: CreditTier[];
  selectedCreditTier: CreditTierEnum | null;
  onCreditTierChange: (tier: CreditTierEnum | null) => void;
  disabled?: boolean;
}

export function CreditBundlePicker({
  creditTiers,
  selectedCreditTier,
  onCreditTierChange,
  disabled = false,
}: CreditBundlePickerProps) {
  const { t } = useTranslation("settings");

  const options: SelectOption<CreditOptionValue>[] = useMemo(() => {
    const noBundle = {
      value: null,
      label: t("creditBundlePicker.noBundleOption", {
        price: formatMonthly(0),
      }),
    };
    const tierOptions = creditTiers.map((tier) => ({
      value: tier.tier,
      label: formatBundleOptionLabel(tier),
    }));
    return [noBundle, ...tierOptions];
  }, [creditTiers, t]);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1">
        <Typography
          as="p"
          variant="label-small-default"
          className="text-[var(--content-secondary)]"
        >
          {t("creditBundlePicker.label")}
        </Typography>
        <span title={t("creditBundlePicker.tooltip")}>
          <Info className="h-3 w-3 text-[var(--content-tertiary)]" />
        </span>
      </div>
      <Select<CreditOptionValue>
        aria-label={t("creditBundlePicker.ariaLabel")}
        placeholder={t("creditBundlePicker.placeholder")}
        disabled={disabled}
        value={selectedCreditTier}
        // Narrowing the catalog's `string` back to `CreditTierEnum` is
        // unavoidable while the two disagree; LUM-3093 tracks aligning them.
        onChange={(value) => onCreditTierChange(value as CreditTierEnum)}
        onSelectNone={() => onCreditTierChange(null)}
        options={options}
      />
    </div>
  );
}
