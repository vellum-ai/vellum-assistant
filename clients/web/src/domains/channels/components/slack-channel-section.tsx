import { useQuery } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";

import { Card } from "@vellumai/design-library/components/card";
import { Collapsible } from "@vellumai/design-library/components/collapsible";
import { Notice } from "@vellumai/design-library/components/notice";
import { Typography } from "@vellumai/design-library/components/typography";

import { useTranslation } from "@/i18n";
import { SlackChannelList } from "@/domains/channels/components/slack-channel-list";
import { SlackChannelTypeDefaults } from "@/domains/channels/components/slack-channel-type-defaults";
import { useChannelPermissionOverrides } from "@/domains/channels/hooks/use-channel-permission-overrides";
import { memberSlackChannelsOptions } from "@/domains/channels/slack-channels-query";
import { getGlobalThresholds } from "@/lib/threshold-api";

export interface SlackChannelSectionProps {
  assistantId: string;
  /** Trimmed assistant name with a "your assistant" fallback, for copy. */
  assistantDisplayName: string;
  /** The assistant's Slack handle for the `/invite` and `/remove` hints. */
  slackHandle?: string;
}

/**
 * Data container for the Slack sub-tab. When access controls are supported the
 * primary card maps each conversation type (Channels, Direct messages) to its
 * default Assistant Access level, and the per-channel presence list lives in a
 * single "Per-channel overrides" card below it that expands in place — the card
 * header is the toggle, so there's no bare trigger stacked on a second card.
 * Individual channels matter less than the type default, so they start
 * collapsed. Against an older assistant (no channel-permission routes) it falls
 * back to the bare presence list in a plain card with no pickers.
 *
 * Mounts only while Slack is connected (the panel renders it conditionally), so
 * the queries need no connection gate of their own.
 */
export function SlackChannelSection({
  assistantId,
  assistantDisplayName,
  slackHandle,
}: SlackChannelSectionProps) {
  const { t } = useTranslation("channels");
  const channelsQuery = useQuery({
    ...memberSlackChannelsOptions(assistantId),
    enabled: Boolean(assistantId),
    select: (data) => data.channels,
  });

  const overrides = useChannelPermissionOverrides({
    assistantId,
    adapter: "slack",
  });

  // Global thresholds back the "default" badge only after the gateway
  // resolve confirms no broader-scope cell applies. Shares the Risk
  // Tolerance settings page's query key, so the cache is shared.
  const thresholdsQuery = useQuery({
    queryKey: ["thresholds", assistantId],
    queryFn: () => getGlobalThresholds(assistantId),
    enabled: overrides.supported && Boolean(assistantId),
    staleTime: 30_000,
  });
  const interactive = thresholdsQuery.data?.interactive ?? null;
  // While the resolve query is pending or errored the fall-through is
  // unknown — keep the tier null so rows show a plain "Default" badge
  // rather than guessing a tier a broader cell might contradict.
  const defaultTier =
    overrides.defaultCellTier === undefined
      ? null
      : (overrides.defaultCellTier ?? interactive);

  const list = (
    <SlackChannelList
      assistantDisplayName={assistantDisplayName}
      slackHandle={slackHandle}
      accessControlsSupported={overrides.supported}
      defaultTier={defaultTier}
      channels={channelsQuery.data}
      loading={channelsQuery.isPending}
      error={channelsQuery.isError}
      tierOverrides={overrides.tierOverrides}
      tierOverridesLoading={overrides.isLoading}
      tierOverridesError={overrides.isError}
      pendingChannelIds={overrides.pendingChannelIds}
      onTierChange={overrides.onTierChange}
      onTierReset={overrides.onTierReset}
    />
  );

  // Older assistant without the channel-permission routes: no per-type defaults
  // to map, so show the bare presence list in a plain card of its own — nothing
  // to collapse, and no default-access card above to own the framing.
  if (
    !overrides.supported ||
    !overrides.onBucketChange ||
    !overrides.onBucketReset
  ) {
    return (
      <Card.Root noPadding clipContents>
        {list}
      </Card.Root>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* The pickers below hold disabled while the stored cells are unknown
          (see `useChannelPermissionOverrides`); say why, or a dead dropdown is
          all the user sees. Writing over cells we couldn't read would silently
          clobber them, so there's nothing to offer here but a reload. */}
      {overrides.isError ? (
        <Notice tone="error">
          {t("slackChannelSection.overridesLoadFailed")}
        </Notice>
      ) : null}
      <SlackChannelTypeDefaults
        assistantName={assistantDisplayName}
        globalDefaultTier={interactive}
        bucketTiers={overrides.bucketTiers}
        loading={overrides.isLoading}
        error={overrides.isError}
        pendingBuckets={overrides.pendingBuckets}
        onBucketChange={overrides.onBucketChange}
        onBucketReset={overrides.onBucketReset}
      />
      {/* One card that expands: the header is the toggle, the bare list drops
          straight in below it — no trigger-then-separate-card double frame. */}
      <Card.Root noPadding clipContents>
        <Collapsible.Root type="single" collapsible>
          <Collapsible.Item value="per-channel-overrides">
            <Collapsible.Trigger className="group justify-between gap-2 px-4 py-3">
              <Typography as="span" variant="body-small-emphasised">
                {t("slackChannelSection.perChannelOverrides")}
              </Typography>
              <ChevronDown
                aria-hidden="true"
                className="h-4 w-4 shrink-0 text-[var(--content-tertiary)] transition-transform group-data-[state=open]:rotate-180"
              />
            </Collapsible.Trigger>
            <Collapsible.Content className="border-[var(--border-base)] data-[state=open]:border-t">
              {list}
            </Collapsible.Content>
          </Collapsible.Item>
        </Collapsible.Root>
      </Card.Root>
    </div>
  );
}
