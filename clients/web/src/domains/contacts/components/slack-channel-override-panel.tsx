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
import {
  getPolicyDescriptions,
  POLICY_LABELS,
  type AdmissionPolicy,
} from "@/lib/channel-admission-policy/types";

export interface SlackChannelOverridePanelProps {
  /** Row's channel name, for accessible control labels. */
  channelName: string;
  /** Lowercase room-type word for the custom-capabilities callout copy. */
  kindLabel: "public" | "private";
  /** Trimmed assistant name with a "your assistant" fallback, for copy. */
  assistantDisplayName: string;
  /**
   * The Slack trust floor, shown read-only so the row answers "who can
   * reach the assistant here". Admission is a channel-type setting — the
   * control lives in the "Who can message" dropdown, not per room.
   */
  admissionPolicy?: AdmissionPolicy;
  settings: SlackChannelTierSettings;
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
 * Expanded-row settings for one Slack channel: the capabilities tier
 * (the only per-room knob — admission is a channel-type concern), with a
 * custom-capabilities callout + reset when the tier diverges from the
 * channel-type default. Persists as channel-ID cells via the gateway SDK.
 */
export function SlackChannelOverridePanel({
  channelName,
  kindLabel,
  assistantDisplayName,
  admissionPolicy,
  settings,
  loading = false,
  error = false,
  onTierChange,
  onReset,
}: SlackChannelOverridePanelProps) {
  const unavailable = loading || error;
  const tierItems = CAPABILITY_TIER_VALUES.map((tier) => ({
    value: tier,
    label: CAPABILITY_TIER_META[tier].label,
    disabled: unavailable,
  }));
  const tierMeta = CAPABILITY_TIER_META[settings.tier];

  return (
    <div className="flex flex-col gap-3 px-2 pt-1 pb-4">
      {admissionPolicy ? (
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between gap-2">
            <Typography
              as="span"
              variant="body-small-emphasised"
              className="text-[color:var(--content-secondary)]"
            >
              Who can reach {assistantDisplayName} here
            </Typography>
            <Typography
              as="span"
              variant="body-small-default"
              className="text-[color:var(--content-tertiary)]"
            >
              {POLICY_LABELS[admissionPolicy]} — all of Slack
            </Typography>
          </div>
          <Typography
            as="p"
            variant="body-small-default"
            className="text-[color:var(--content-tertiary)]"
          >
            {getPolicyDescriptions(assistantDisplayName)[admissionPolicy]}{" "}
            Set once for all Slack channels in “Who can message{" "}
            {assistantDisplayName}” above.
          </Typography>
        </div>
      ) : null}
      {settings.overridden ? (
        <Notice
          tone="warning"
          title="Custom capabilities."
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
        value={settings.tier}
        onChange={onTierChange}
        ariaLabel={`Capabilities in ${channelName}`}
      />
      <Typography
        as="p"
        variant="body-small-default"
        className="text-[color:var(--content-tertiary)]"
      >
        {settings.overridden ? (
          <>
            {tierMeta.label} — {tierMeta.sublabel}. {tierMeta.description}
          </>
        ) : (
          // Without a persisted cell the runtime falls through to the
          // global auto-approve setting; the tier copy would overclaim.
          <>
            No channel override — this channel follows your global
            auto-approve setting. Pick a tier to set one.
          </>
        )}
      </Typography>
    </div>
  );
}
