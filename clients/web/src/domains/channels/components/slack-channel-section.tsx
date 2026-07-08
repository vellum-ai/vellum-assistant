import { useQuery } from "@tanstack/react-query";

import { SlackChannelList } from "@/domains/channels/components/slack-channel-list";
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
 * Data container for the Slack sub-tab's room list: the member-only
 * channels query and the per-channel capabilities-tier persistence. Mounts
 * only while Slack is connected (the panel renders it conditionally), so
 * the queries need no connection gate of their own. Access controls are
 * version-gated by the overrides hook; against an older assistant the
 * list renders channels without tier badges or pickers.
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

  return (
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
}
