import { useQuery } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";

import { Collapsible } from "@vellumai/design-library/components/collapsible";
import { Typography } from "@vellumai/design-library/components/typography";

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
 * default Assistant Access level, and the per-channel presence list drops into a
 * collapsible below it — individual channels matter less than the type default,
 * so they stay out of the way. Against an older assistant (no channel-permission
 * routes) it falls back to the plain presence list with no pickers.
 *
 * Mounts only while Slack is connected (the panel renders it conditionally), so
 * the queries need no connection gate of their own.
 */
export function SlackChannelSection({
  assistantId,
  assistantDisplayName,
  slackHandle,
}: SlackChannelSectionProps) {
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
      // The default-access card above owns the key when access controls are on.
      showLegend={!overrides.supported}
    />
  );

  // Older assistant without the channel-permission routes: no per-type defaults
  // to map, so show the plain presence list on its own.
  if (
    !overrides.supported ||
    !overrides.onBucketChange ||
    !overrides.onBucketReset
  ) {
    return list;
  }

  return (
    <div className="flex flex-col gap-4">
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
      <Collapsible.Root type="single" collapsible>
        <Collapsible.Item value="individual-channels">
          <Collapsible.Trigger className="group justify-between gap-2 px-1 py-2">
            <Typography as="span" variant="body-small-emphasised">
              Individual channels
            </Typography>
            <ChevronDown
              aria-hidden="true"
              className="h-4 w-4 shrink-0 text-[var(--content-tertiary)] transition-transform group-data-[state=open]:rotate-180"
            />
          </Collapsible.Trigger>
          <Collapsible.Content>
            <div className="pt-3">{list}</div>
          </Collapsible.Content>
        </Collapsible.Item>
      </Collapsible.Root>
    </div>
  );
}
