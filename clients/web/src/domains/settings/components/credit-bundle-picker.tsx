import { Info } from "lucide-react";
import { useMemo } from "react";

import type { CreditTier, CreditTierEnum } from "@/generated/api/types.gen";
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

/** "50 credits — $50/mo" for a catalog tier. */
export function formatBundleOptionLabel(tier: CreditTier): string {
  return `${tier.label} — ${formatMonthly(tier.price_cents)}`;
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
  const options: SelectOption<CreditOptionValue>[] = useMemo(() => {
    const noBundle = {
      value: null,
      label: `No credit bundle — ${formatMonthly(0)}`,
    };
    const tierOptions = creditTiers.map((t) => ({
      value: t.tier,
      label: formatBundleOptionLabel(t),
    }));
    return [noBundle, ...tierOptions];
  }, [creditTiers]);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1">
        <Typography
          as="p"
          variant="label-small-default"
          className="text-[var(--content-secondary)]"
        >
          Credit bundle
        </Typography>
        <span title="A monthly allotment of credits added to your Pro Plan subscription">
          <Info className="h-3 w-3 text-[var(--content-tertiary)]" />
        </span>
      </div>
      <Select<CreditOptionValue>
        aria-label="Credit bundle"
        placeholder="Select a credit bundle"
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
