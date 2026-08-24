import { Info } from "lucide-react";
import { useMemo } from "react";

import type {
  MachineTier,
  MachineTierEnum,
  StorageTier,
  StorageTierEnum,
} from "@/generated/api/types.gen";
import { useTranslation } from "@/i18n";
import { MACHINE_TIER_LABEL } from "@/lib/billing/machine-sizes";
import { Select } from "@vellumai/design-library/components/select";
import { Typography } from "@vellumai/design-library/components/typography";

import { formatDelta, formatMonthly } from "./tier-pricing";

/**
 * `disabled` is not (yet) part of the generated MachineTier/StorageTier
 * types — the plans serializer does not emit it today. Read it defensively
 * so the picker honors it the moment the backend starts sending it, with no
 * frontend change required. The cast is required because the field is absent
 * from the generated types; an `{ disabled?: boolean }` parameter would trip
 * TS's weak-type check (TS2559) since the tier types share no properties with
 * it.
 */
export function isTierDisabled(tier: MachineTier | StorageTier): boolean {
  return (tier as unknown as { disabled?: boolean }).disabled === true;
}

export interface TierPickerProps {
  machineTiers: MachineTier[];
  storageTiers: StorageTier[];
  selectedMachineTier: MachineTierEnum | null;
  selectedStorageTier: StorageTierEnum | null;
  onMachineTierChange: (tier: MachineTierEnum) => void;
  onStorageTierChange: (tier: StorageTierEnum) => void;
  currentMachinePriceCents?: number | null;
  currentStoragePriceCents?: number | null;
}

export function TierPicker({
  machineTiers,
  storageTiers,
  selectedMachineTier,
  selectedStorageTier,
  onMachineTierChange,
  onStorageTierChange,
  currentMachinePriceCents,
  currentStoragePriceCents,
}: TierPickerProps) {
  const { t } = useTranslation("settings");

  const machineOptions = useMemo(
    () =>
      machineTiers.map((tier) => {
        const label = MACHINE_TIER_LABEL[tier.tier] ?? tier.label;
        const priceLabel =
          currentMachinePriceCents != null
            ? tier.price_cents === currentMachinePriceCents
              ? t("tierPicker.priceCurrent", {
                  price: formatMonthly(tier.price_cents),
                })
              : formatDelta(tier.price_cents - currentMachinePriceCents)
            : t("tierPicker.priceAddon", {
                price: formatMonthly(tier.price_cents),
              });
        return {
          value: tier.tier as MachineTierEnum,
          label: t("tierPicker.machineOption", { label, priceLabel }),
          disabled: isTierDisabled(tier),
        };
      }),
    [machineTiers, currentMachinePriceCents, t],
  );

  const storageOptions = useMemo(
    () =>
      storageTiers.map((tier) => {
        const priceLabel =
          currentStoragePriceCents != null
            ? tier.price_cents === currentStoragePriceCents
              ? t("tierPicker.priceCurrent", {
                  price: formatMonthly(tier.price_cents),
                })
              : formatDelta(tier.price_cents - currentStoragePriceCents)
            : t("tierPicker.priceAddon", {
                price: formatMonthly(tier.price_cents),
              });
        return {
          value: tier.tier as StorageTierEnum,
          label: t("tierPicker.storageOption", {
            gib: tier.storage_gib,
            priceLabel,
          }),
          disabled: isTierDisabled(tier),
        };
      }),
    [storageTiers, currentStoragePriceCents, t],
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-1">
          <Typography
            as="p"
            variant="label-small-default"
            className="text-[var(--content-secondary)]"
          >
            {t("tierPicker.machineLabel")}
          </Typography>
          <span title={t("tierPicker.machineTooltip")}>
            <Info className="h-3 w-3 text-[var(--content-tertiary)]" />
          </span>
        </div>
        <Select<MachineTierEnum>
          aria-label={t("tierPicker.machineAriaLabel")}
          placeholder={t("tierPicker.machinePlaceholder")}
          value={selectedMachineTier ?? ("" as MachineTierEnum)}
          onChange={onMachineTierChange}
          options={machineOptions}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-1">
          <Typography
            as="p"
            variant="label-small-default"
            className="text-[var(--content-secondary)]"
          >
            {t("tierPicker.storageLabel")}
          </Typography>
          <span title={t("tierPicker.storageTooltip")}>
            <Info className="h-3 w-3 text-[var(--content-tertiary)]" />
          </span>
        </div>
        <Select<StorageTierEnum>
          aria-label={t("tierPicker.storageAriaLabel")}
          placeholder={t("tierPicker.storagePlaceholder")}
          value={selectedStorageTier ?? ("" as StorageTierEnum)}
          onChange={onStorageTierChange}
          options={storageOptions}
        />
      </div>
    </div>
  );
}
