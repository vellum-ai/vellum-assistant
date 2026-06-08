import { Info } from "lucide-react";
import { useMemo } from "react";

import type {
    MachineTier,
    MachineTierEnum,
    StorageTier,
    StorageTierEnum,
} from "@/generated/api/types.gen";
import { Dropdown } from "@vellumai/design-library/components/dropdown";
import { Typography } from "@vellumai/design-library/components/typography";
import { formatDelta, formatMonthly } from "./tier-pricing";

/**
 * Display labels for the Pro machine tiers. Uses a static label map so casing
 * is stable regardless of what the API returns in `tier.label`.
 */
const MACHINE_TIER_LABEL: Record<string, string> = {
  medium: "Medium",
  large: "Large",
  xl: "XL",
};

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
  const machineOptions = useMemo(
    () =>
      machineTiers.map((t) => {
        const label = MACHINE_TIER_LABEL[t.tier] ?? t.label;
        const priceLabel =
          currentMachinePriceCents != null
            ? t.price_cents === currentMachinePriceCents
              ? `(${formatMonthly(t.price_cents)}, current)`
              : formatDelta(t.price_cents - currentMachinePriceCents)
            : `+${formatMonthly(t.price_cents)}`;
        return {
          value: t.tier as MachineTierEnum,
          label: `${label} ${priceLabel}`,
          disabled: isTierDisabled(t),
        };
      }),
    [machineTiers, currentMachinePriceCents],
  );

  const storageOptions = useMemo(
    () =>
      storageTiers.map((t) => {
        const priceLabel =
          currentStoragePriceCents != null
            ? t.price_cents === currentStoragePriceCents
              ? `(${formatMonthly(t.price_cents)}, current)`
              : formatDelta(t.price_cents - currentStoragePriceCents)
            : `+${formatMonthly(t.price_cents)}`;
        return {
          value: t.tier as StorageTierEnum,
          label: `${t.storage_gib} GiB ${priceLabel}`,
          disabled: isTierDisabled(t),
        };
      }),
    [storageTiers, currentStoragePriceCents],
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
            Machine
          </Typography>
          <span title="Determines the CPU and memory allocated to your assistant">
            <Info className="h-3 w-3 text-[var(--content-tertiary)]" />
          </span>
        </div>
        <Dropdown<MachineTierEnum>
          aria-label="Machine tier"
          placeholder="Select a machine tier"
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
            Storage
          </Typography>
          <span title="Persistent disk space for your assistant&#39;s files and data">
            <Info className="h-3 w-3 text-[var(--content-tertiary)]" />
          </span>
        </div>
        <Dropdown<StorageTierEnum>
          aria-label="Storage tier"
          placeholder="Select a storage tier"
          value={selectedStorageTier ?? ("" as StorageTierEnum)}
          onChange={onStorageTierChange}
          options={storageOptions}
        />
      </div>
    </div>
  );
}
