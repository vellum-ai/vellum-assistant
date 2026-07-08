import { Button } from "@vellumai/design-library/components/button";
import { Notice } from "@vellumai/design-library/components/notice";
import { SegmentControl } from "@vellumai/design-library/components/segment-control";
import { Tag } from "@vellumai/design-library/components/tag";
import { Typography } from "@vellumai/design-library/components/typography";

import {
  CAPABILITY_TIER_META,
  CAPABILITY_TIER_VALUES,
  type SlackCapabilityTier,
  type SlackChannelTierSettings,
} from "@/domains/channels/slack-channel-overrides";

export interface SlackChannelOverridePanelProps {
  /** Row's channel name, for accessible control labels. */
  channelName: string;
  settings: SlackChannelTierSettings;
  /**
   * The resolved default for this channel's type when no cell is
   * persisted — shown selected in the picker with "default" status.
   * `null` while unknown; the picker then renders unset.
   */
  defaultTier: SlackCapabilityTier | null;
  /**
   * True until persisted overrides have loaded — the picker holds disabled
   * so a stored tier can't be misread (and overwritten) as the default.
   */
  loading?: boolean;
  /** True when overrides failed to load; the picker stays disabled. */
  error?: boolean;
  onTierChange: (tier: SlackCapabilityTier) => void;
  onReset: () => void;
}

/**
 * Expanded-row settings for one Slack channel: the Assistant Access tier
 * (the only per-room knob — reach is baked into the channel type, with no
 * per-room control), with a custom-access callout + reset when a persisted
 * cell overrides the owner's global setting. Rooms with no cell show an
 * unset picker — pretending a tier is set would misreport the global
 * fall-through. Per-tier descriptions live in the list's one-time legend
 * ({@link SlackChannelTierLegend}), not here. Persists as channel-ID cells
 * via the gateway SDK.
 */
export function SlackChannelOverridePanel({
  channelName,
  settings,
  defaultTier,
  loading = false,
  error = false,
  onTierChange,
  onReset,
}: SlackChannelOverridePanelProps) {
  const unavailable = loading || error;
  const tierItems = CAPABILITY_TIER_VALUES.map((tier) => ({
    value: tier,
    label: CAPABILITY_TIER_META[tier].label,
    sublabel: CAPABILITY_TIER_META[tier].sublabel,
    disabled: unavailable,
  }));

  return (
    <div className="flex flex-col gap-3 px-2 pt-1 pb-4">
      {settings.overridden ? (
        <Notice
          tone="warning"
          title="Custom access."
          className="border-dashed"
          actions={
            <Button
              type="button"
              variant="outlined"
              onClick={onReset}
              disabled={unavailable}
            >
              Reset to default
            </Button>
          }
        >
          This channel isn’t following your global Assistant Access setting.
        </Notice>
      ) : null}
      <div className="flex items-center justify-between gap-2">
        <Typography
          as="span"
          variant="body-small-emphasised"
          className="text-[color:var(--content-secondary)]"
        >
          Assistant Access
        </Typography>
        {loading ? (
          <Typography
            as="span"
            variant="body-small-default"
            className="text-[color:var(--content-tertiary)]"
          >
            Loading…
          </Typography>
        ) : error ? (
          <Typography
            as="span"
            variant="body-small-default"
            className="text-[color:var(--content-negative)]"
          >
            Couldn’t load — try reopening this page
          </Typography>
        ) : settings.overridden ? (
          <Tag tone="warning">overridden</Tag>
        ) : (
          <Typography
            as="span"
            variant="body-small-default"
            className="text-[color:var(--content-tertiary)]"
          >
            default
          </Typography>
        )}
      </div>
      <SegmentControl<SlackCapabilityTier>
        items={tierItems}
        value={settings.tier ?? defaultTier}
        onChange={onTierChange}
        ariaLabel={`Assistant Access in ${channelName}`}
      />
    </div>
  );
}
