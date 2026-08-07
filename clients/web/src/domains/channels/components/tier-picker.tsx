import {
  Select,
  type SelectOption,
} from "@vellumai/design-library/components/select";

import {
  CAPABILITY_TIER_META,
  CHANNEL_TIER_VALUES,
  channelTierBehavesAs,
} from "@/domains/channels/slack-channel-overrides";
import { useTranslation } from "@/i18n";
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
   * The tier this scope falls through to when it has no cell of its own: the
   * level shown with a muted "default" marker. `null` while still unknown, in
   * which case no level carries the marker and the trigger shows a "Default"
   * placeholder.
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
 * channel-type default rows.
 *
 * The menu carries a leading "Default" entry that clears this scope's cell,
 * plus one row per {@link CHANNEL_TIER_VALUES} level. The level the default
 * resolves to also carries a muted "default" marker, and selecting it clears
 * the cell too: "follow the default" and "pick the level it resolves to" are
 * the same choice, which is safe because resolution is most-specific-wins and
 * value-only (see `slack-channel-overrides` and the gateway's
 * `ChannelPermissionStore.resolve`).
 *
 * The "Default" entry is the only choice that means "follow the default"
 * without naming a level. It is the sole route out of a cell pinned to the
 * level the default already resolves to: that cell renders identically to an
 * absent one, and `Select` reports no selection when the chosen value matches
 * the value already shown, so re-picking the level cannot clear it. The entry
 * is also what keeps {@link onReset} reachable while `defaultTier` is null and
 * no level carries the marker.
 *
 * A stored `medium`/`high` cell is shown as the level it behaves as, so the
 * picker never displays a level it cannot offer.
 */
export function TierPicker({
  tier,
  defaultTier,
  disabled,
  onTierChange,
  onReset,
  "aria-label": ariaLabel,
}: TierPickerProps) {
  const { t } = useTranslation("channels");
  const effectiveTier = channelTierBehavesAs(tier ?? defaultTier ?? undefined);
  const shownDefault = channelTierBehavesAs(defaultTier ?? undefined) ?? null;
  const options: SelectOption<TierOptionValue>[] = CHANNEL_TIER_VALUES.map(
    (value) => ({
      value,
      label: CAPABILITY_TIER_META[value].label,
      icon: <TierDot color={CAPABILITY_TIER_META[value].dotColor} />,
      suffix:
        value === shownDefault ? (
          <span className="text-[color:var(--content-tertiary)]">
            {t("tierPicker.defaultSuffix")}
          </span>
        ) : undefined,
      tooltip: CAPABILITY_TIER_META[value].sublabel,
    }),
  );
  // The only choice that clears the cell without naming a level, and the sole
  // route out of a cell pinned to the level the default resolves to: that
  // cell looks identical to an absent one, and a selection matching the
  // displayed value is not reported.
  options.unshift({
    value: DEFAULT_ENTRY,
    label: "Default",
    // Invisible dot so the label aligns with the level rows.
    icon: <TierDot color="transparent" />,
    tooltip: "follows the default level",
  });

  const handleChange = (next: TierOptionValue) => {
    // Picking the level the default resolves to means "follow the default",
    // which is the absence of a cell: clear it rather than pinning an equal
    // one. The "Default" entry is that same choice, and the only one
    // available when a selection matching the displayed value goes
    // unreported. `onReset` is safe to call on a scope with no cell: both
    // call sites skip the round-trip when nothing is persisted.
    if (next === DEFAULT_ENTRY || next === shownDefault) {
      onReset();
    } else {
      onTierChange(next);
    }
  };

  return (
    <Select<TierOptionValue>
      value={effectiveTier ?? ""}
      onChange={handleChange}
      options={options}
      placeholder={t("tierPicker.defaultPlaceholder")}
      disabled={disabled}
      size="compact"
      menuAlign="end"
      aria-label={ariaLabel}
    />
  );
}
