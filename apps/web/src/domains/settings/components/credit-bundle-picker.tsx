import { Info } from "lucide-react";
import { useMemo } from "react";

import type { CreditTier, CreditTierEnum } from "@/generated/api/types.gen";
import { Dropdown } from "@vellumai/design-library/components/dropdown";
import { Typography } from "@vellumai/design-library/components/typography";
import { formatMonthly } from "./tier-pricing";

/**
 * Sentinel option value for the synthesized "No credit bundle" entry. The
 * design-library Dropdown is generic over `T extends string`, so it cannot
 * carry a real `null` value — we map this sentinel to/from `null` at the
 * component boundary so callers see a clean `CreditTierEnum | null`.
 */
const NO_BUNDLE_VALUE = "__none__";

type CreditOptionValue = CreditTierEnum | typeof NO_BUNDLE_VALUE;

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
  const options = useMemo(() => {
    const noBundle = {
      value: NO_BUNDLE_VALUE as CreditOptionValue,
      label: `No credit bundle — ${formatMonthly(0)}`,
    };
    const tierOptions = creditTiers.map((t) => ({
      value: t.tier as CreditOptionValue,
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
      <Dropdown<CreditOptionValue>
        aria-label="Credit bundle"
        placeholder="Select a credit bundle"
        disabled={disabled}
        value={selectedCreditTier ?? NO_BUNDLE_VALUE}
        onChange={(value) =>
          onCreditTierChange(
            value === NO_BUNDLE_VALUE ? null : (value as CreditTierEnum),
          )
        }
        options={options}
      />
    </div>
  );
}
