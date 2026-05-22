import { Info } from "lucide-react";

import { Dropdown } from "@vellum/design-library/components/dropdown";
import { Typography } from "@vellum/design-library/components/typography";
import type {
  MachineTier,
  MachineTierEnum,
  StorageTier,
  StorageTierEnum,
} from "@/generated/api/types.gen.js";

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

/** "$50/mo" for whole-dollar tiers; "$50.50/mo" only when cents are present. */
function formatMonthly(totalCents: number): string {
  const dollars = totalCents / 100;
  return Number.isInteger(dollars)
    ? `$${dollars}/mo`
    : `$${dollars.toFixed(2)}/mo`;
}

export interface TierPickerProps {
  machineTiers: MachineTier[];
  storageTiers: StorageTier[];
  basePriceCents: number;
  selectedMachineTier: MachineTierEnum | null;
  selectedStorageTier: StorageTierEnum | null;
  onMachineTierChange: (tier: MachineTierEnum) => void;
  onStorageTierChange: (tier: StorageTierEnum) => void;
}

export function TierPicker({
  machineTiers,
  storageTiers,
  basePriceCents,
  selectedMachineTier,
  selectedStorageTier,
  onMachineTierChange,
  onStorageTierChange,
}: TierPickerProps) {
  const selectedMachine = machineTiers.find(
    (t) => t.tier === selectedMachineTier,
  );
  const selectedStorage = storageTiers.find(
    (t) => t.tier === selectedStorageTier,
  );
  const totalCents =
    selectedMachine && selectedStorage
      ? basePriceCents +
        selectedMachine.price_cents +
        selectedStorage.price_cents
      : null;

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
          options={machineTiers.map((t) => ({
            value: t.tier as MachineTierEnum,
            label: `${MACHINE_TIER_LABEL[t.tier] ?? t.label} +${formatMonthly(
              t.price_cents,
            )}`,
            disabled: isTierDisabled(t),
          }))}
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
          options={storageTiers.map((t) => ({
            value: t.tier as StorageTierEnum,
            label: `${t.storage_gib} GiB +${formatMonthly(t.price_cents)}`,
            disabled: isTierDisabled(t),
          }))}
        />
      </div>
      {totalCents !== null && (
        <div className="flex items-center gap-1">
          <Typography
            as="p"
            variant="body-small-emphasised"
            data-testid="tier-picker-total"
            className="text-[var(--content-default)]"
          >
            Total: {formatMonthly(totalCents)}
          </Typography>
          <span title="Includes a $10/mo platform fee">
            <Info className="h-3 w-3 text-[var(--content-tertiary)]" />
          </span>
        </div>
      )}
    </div>
  );
}
