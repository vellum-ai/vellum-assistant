import {
  Dropdown,
  type DropdownOption,
} from "@vellumai/design-library/components/dropdown";

import {
  CAPABILITY_TIER_META,
  CAPABILITY_TIER_VALUES,
} from "@/domains/channels/slack-channel-overrides";
import type { RiskThreshold } from "@/utils/threshold-presets";

/** Small accent dot, colored per tier via `CAPABILITY_TIER_META.dotColor`. */
export function TierDot({ color }: { color: string }) {
  return (
    <span
      aria-hidden="true"
      className="h-1.5 w-1.5 rounded-full"
      style={{ backgroundColor: color }}
    />
  );
}

export interface TierPickerProps {
  /** The persisted tier for this scope, or `undefined` when it follows the default. */
  tier: RiskThreshold | undefined;
  /**
   * The tier this scope falls through to when it has no cell of its own — the
   * level shown with a muted "default" marker. `null` while still unknown, in
   * which case no level is marked and the trigger shows a "Default" placeholder.
   */
  defaultTier: RiskThreshold | null;
  disabled?: boolean;
  /** Persist an explicit tier for this scope. */
  onTierChange: (tier: RiskThreshold) => void;
  /** Clear this scope's cell so it follows the default again. */
  onReset: () => void;
  "aria-label": string;
}

/**
 * The compact Assistant Access picker shared by the per-channel rows and the
 * channel-type default rows. Lists the four levels only — no separate "Default"
 * option: the level equal to the resolved default carries a muted "default"
 * marker, selecting it clears this scope's cell (follow the default), and
 * selecting any other level pins an override. This keeps "follow the default"
 * and "pick the level it resolves to" the same choice, and is safe because
 * resolution is most-specific-wins and value-only (see `slack-channel-overrides`
 * and the gateway's `ChannelPermissionStore.resolve`).
 */
export function TierPicker({
  tier,
  defaultTier,
  disabled,
  onTierChange,
  onReset,
  "aria-label": ariaLabel,
}: TierPickerProps) {
  const effectiveTier = tier ?? defaultTier;
  const options: DropdownOption<RiskThreshold>[] = CAPABILITY_TIER_VALUES.map(
    (value) => ({
      value,
      label: CAPABILITY_TIER_META[value].label,
      icon: <TierDot color={CAPABILITY_TIER_META[value].dotColor} />,
      suffix:
        value === defaultTier ? (
          <span className="text-[color:var(--content-tertiary)]">default</span>
        ) : undefined,
      tooltip: CAPABILITY_TIER_META[value].sublabel,
    }),
  );

  const handleChange = (next: RiskThreshold) => {
    // Picking the level the default resolves to means "follow the default",
    // which is the absence of a cell — clear it rather than pinning an equal one.
    if (next === defaultTier) {
      onReset();
    } else {
      onTierChange(next);
    }
  };

  return (
    <Dropdown<RiskThreshold>
      value={effectiveTier ?? ""}
      onChange={handleChange}
      options={options}
      placeholder="Default"
      disabled={disabled}
      size="compact"
      menuAlign="end"
      aria-label={ariaLabel}
    />
  );
}
