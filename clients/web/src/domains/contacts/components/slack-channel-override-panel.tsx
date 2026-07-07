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
} from "@/domains/contacts/slack-channel-overrides";

export interface SlackChannelOverridePanelProps {
  /** Row's channel name, for accessible control labels. */
  channelName: string;
  /** Lowercase channel-type word for the custom-capabilities callout copy. */
  kindLabel: "public" | "private" | "DM";
  settings: SlackChannelTierSettings;
  /**
   * True until persisted overrides have loaded — the picker holds disabled
   * so a stored tier can't be misread (and overwritten) as the default.
   */
  loading?: boolean;
  onTierChange: (tier: SlackCapabilityTier) => void;
  onReset: () => void;
}

/**
 * Expanded-row settings for one Slack channel: the capabilities tier
 * (the only per-room knob — admission is a channel-type concern), with a
 * custom-capabilities callout + reset when the tier diverges from the
 * channel-type default. Persists as channel-ID cells via the gateway SDK.
 */
export function SlackChannelOverridePanel({
  channelName,
  kindLabel,
  settings,
  loading = false,
  onTierChange,
  onReset,
}: SlackChannelOverridePanelProps) {
  const tierItems = CAPABILITY_TIER_VALUES.map((tier) => ({
    value: tier,
    label: CAPABILITY_TIER_META[tier].label,
    disabled: loading,
  }));
  const tierMeta = CAPABILITY_TIER_META[settings.tier];

  return (
    <div className="flex flex-col gap-3 px-2 pt-1 pb-4">
      {settings.overridden ? (
        <Notice
          tone="warning"
          title="Custom capabilities."
          className="border-dashed"
          actions={
            <Button type="button" variant="outlined" onClick={onReset}>
              Reset to default
            </Button>
          }
        >
          This channel isn’t using the {kindLabel} default.
        </Notice>
      ) : null}
      <div className="flex items-center justify-between gap-2">
        <Typography
          as="span"
          variant="body-small-emphasised"
          className="text-[color:var(--content-secondary)]"
        >
          Capabilities
        </Typography>
        {loading ? (
          <Typography
            as="span"
            variant="body-small-default"
            className="text-[color:var(--content-tertiary)]"
          >
            Loading…
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
        value={settings.tier}
        onChange={onTierChange}
        ariaLabel={`Capabilities in ${channelName}`}
      />
      <Typography
        as="p"
        variant="body-small-default"
        className="text-[color:var(--content-tertiary)]"
      >
        {tierMeta.label} — {tierMeta.sublabel}. {tierMeta.description}
      </Typography>
    </div>
  );
}
