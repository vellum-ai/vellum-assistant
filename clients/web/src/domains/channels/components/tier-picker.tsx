import {
  Dropdown,
  type DropdownOption,
} from "@vellumai/design-library/components/dropdown";

import {
  CAPABILITY_TIER_META,
  CHANNEL_TIER_VALUES,
  channelTierBehavesAs,
} from "@/domains/channels/slack-channel-overrides";
import type { RiskThreshold } from "@/utils/threshold-presets";

/**
 * Menu value for the explicit "Default" entry shown while the default is
 * unresolved. Never collides with a {@link RiskThreshold} value.
 */
const DEFAULT_ENTRY = "__default__";

type TierOptionValue = RiskThreshold | typeof DEFAULT_ENTRY;

/** Small accent dot, colored per tier via `CAPABILITY_TIER_META.dotColor`. */
export function TierDot({ color }: { color: string }) {
  return (
    <span
      aria-hidden="true"
      className="h-1.5 w-1.5 shrink-0 rounded-full"
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
   * which case no level is marked, the trigger shows a "Default" placeholder,
   * and the menu carries an explicit "Default" entry so {@link onReset} stays
   * reachable.
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
 * channel-type default rows. Lists {@link CHANNEL_TIER_VALUES} only — no
 * separate "Default" option: the level equal to the resolved default carries a
 * muted "default" marker, selecting it clears this scope's cell (follow the
 * default), and selecting any other level pins an override. This keeps "follow
 * the default" and "pick the level it resolves to" the same choice, and is safe
 * because resolution is most-specific-wins and value-only (see
 * `slack-channel-overrides` and the gateway's `ChannelPermissionStore.resolve`).
 *
 * A stored `medium`/`high` cell is shown as the level it behaves as, so the
 * picker never displays a level it cannot offer.
 *
 * While the default is unresolved (`defaultTier` null) no level can carry the
 * marker, and the picker cannot tell which level the default resolves to, so
 * selecting a level always pins it. The menu instead carries an explicit
 * "Default" entry that clears this scope's cell: the one selection that means
 * "follow the default" without guessing at a level, keeping {@link onReset}
 * reachable in this state.
 */
export function TierPicker({
  tier,
  defaultTier,
  disabled,
  onTierChange,
  onReset,
  "aria-label": ariaLabel,
}: TierPickerProps) {
  const effectiveTier = channelTierBehavesAs(tier ?? defaultTier ?? undefined);
  const shownDefault = channelTierBehavesAs(defaultTier ?? undefined) ?? null;
  const options: DropdownOption<TierOptionValue>[] = CHANNEL_TIER_VALUES.map(
    (value) => ({
      value,
      label: CAPABILITY_TIER_META[value].label,
      icon: <TierDot color={CAPABILITY_TIER_META[value].dotColor} />,
      suffix:
        value === shownDefault ? (
          <span className="text-[color:var(--content-tertiary)]">default</span>
        ) : undefined,
      tooltip: CAPABILITY_TIER_META[value].sublabel,
    }),
  );
  if (shownDefault === null) {
    options.unshift({
      value: DEFAULT_ENTRY,
      label: "Default",
      // Invisible dot so the label aligns with the level rows.
      icon: <TierDot color="transparent" />,
      tooltip: "follows the default level",
    });
  }

  const handleChange = (next: TierOptionValue) => {
    // Picking the level the default resolves to means "follow the default",
    // which is the absence of a cell: clear it rather than pinning an equal
    // one. The explicit "Default" entry is that same choice for when the
    // default is unresolved and no level carries the marker.
    if (next === DEFAULT_ENTRY || next === shownDefault) {
      onReset();
    } else {
      onTierChange(next);
    }
  };

  return (
    <Dropdown<TierOptionValue>
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
