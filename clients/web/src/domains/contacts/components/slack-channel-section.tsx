import { useQuery } from "@tanstack/react-query";

import {
  buildVerifiedSlackContactNames,
  SlackChannelList,
} from "@/domains/contacts/components/slack-channel-list";
import { useChannelPermissionOverrides } from "@/domains/contacts/hooks/use-channel-permission-overrides";
import { memberSlackChannelsOptions } from "@/domains/contacts/slack-channels-query";
import { contactsGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";

export interface SlackChannelSectionProps {
  assistantId: string;
  /** Trimmed assistant name with a "your assistant" fallback, for copy. */
  assistantDisplayName: string;
  /** The assistant's Slack handle for the `/invite` and `/remove` hints. */
  slackHandle?: string;
}

/**
 * Data container for the Slack sub-tab's channel list: the member-only
 * channels query, the verified-contact lookup behind DM badges, and the
 * per-channel capabilities-tier persistence. Mounts only while Slack is
 * connected (the panel renders it conditionally), so the queries need no
 * connection gate of their own.
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

  // Verified-contact lookup for the DM rows' badges. Shares the contacts
  // cache with the Contacts page (same key, own select).
  const verifiedContactsQuery = useQuery({
    ...contactsGetOptions({ path: { assistant_id: assistantId } }),
    enabled: Boolean(assistantId),
    select: (data) => buildVerifiedSlackContactNames(data.contacts),
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
      verifiedDmContactNames={verifiedContactsQuery.data}
      tierOverrides={overrides.tierOverrides}
      tierOverridesLoading={overrides.isLoading}
      pendingChannelIds={overrides.pendingChannelIds}
      onTierChange={overrides.onTierChange}
      onTierReset={overrides.onTierReset}
    />
  );
}
