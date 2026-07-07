import { useQuery } from "@tanstack/react-query";

import { SlackChannelList } from "@/domains/contacts/components/slack-channel-list";
import { useChannelPermissionOverrides } from "@/domains/contacts/hooks/use-channel-permission-overrides";
import { memberSlackChannelsOptions } from "@/domains/contacts/slack-channels-query";
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

  // The default a cell-less row resolves to: the winning broader-scope
  // matrix cell for its channel type, else the owner's global interactive
  // threshold (channel turns run as conversation context). Thresholds
  // share the Risk Tolerance settings page's query key, so the cache is
  // shared.
  const thresholdsQuery = useQuery({
    queryKey: ["thresholds", assistantId],
    queryFn: () => getGlobalThresholds(assistantId),
    enabled: Boolean(assistantId),
    staleTime: 30_000,
  });
  const interactive = thresholdsQuery.data?.interactive ?? null;
  const defaultTiers = {
    public: overrides.typeDefaults?.public ?? interactive,
    private: overrides.typeDefaults?.private ?? interactive,
  };

  return (
    <SlackChannelList
      assistantDisplayName={assistantDisplayName}
      slackHandle={slackHandle}
      defaultTiers={defaultTiers}
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
