import type { QueryClient } from "@tanstack/react-query";

import { memberSlackChannelsQueryKey } from "@/domains/channels/slack-channels-query";
import { slackRosterQueryKey } from "@/domains/contacts/slack-users-query";

/**
 * Drop every Slack-workspace-scoped cache (member channel list + user
 * roster). Both are scoped to whichever workspace the stored credentials
 * point at, so every path that changes those credentials (save, disconnect)
 * must call this — serving either cache across a reconnect would misreport
 * the previous workspace's channels/members. Lives at the top level because
 * it spans the channels and contacts domains' caches.
 */
export function removeSlackWorkspaceQueries(
  queryClient: QueryClient,
  assistantId: string,
): void {
  queryClient.removeQueries({
    queryKey: memberSlackChannelsQueryKey(assistantId),
  });
  queryClient.removeQueries({ queryKey: slackRosterQueryKey(assistantId) });
}
