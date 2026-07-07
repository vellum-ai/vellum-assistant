import { useQuery } from "@tanstack/react-query";

import { SlackChannelList } from "@/domains/contacts/components/slack-channel-list";
import { useChannelPermissionOverrides } from "@/domains/contacts/hooks/use-channel-permission-overrides";
import { memberSlackChannelsOptions } from "@/domains/contacts/slack-channels-query";
import type { AdmissionPolicy } from "@/lib/channel-admission-policy/types";

export interface SlackChannelSectionProps {
  assistantId: string;
  /** Trimmed assistant name with a "your assistant" fallback, for copy. */
  assistantDisplayName: string;
  /** The assistant's Slack handle for the `/invite` and `/remove` hints. */
  slackHandle?: string;
  /** Slack trust floor, shown read-only in expanded rows. */
  admissionPolicy?: AdmissionPolicy;
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
  admissionPolicy,
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

  return (
    <SlackChannelList
      assistantDisplayName={assistantDisplayName}
      slackHandle={slackHandle}
      channels={channelsQuery.data}
      loading={channelsQuery.isPending}
      error={channelsQuery.isError}
      tierOverrides={overrides.tierOverrides}
      tierOverridesLoading={overrides.isLoading}
      tierOverridesError={overrides.isError}
      pendingChannelIds={overrides.pendingChannelIds}
      onTierChange={overrides.onTierChange}
      onTierReset={overrides.onTierReset}
      admissionPolicy={admissionPolicy}
    />
  );
}
