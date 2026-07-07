/**
 * Shared query options/key for the member-only Slack channel list
 * (`GET /v1/slack/channels?memberOnly=true`) shown in the Slack sub-tab.
 *
 * The cached list is scoped to whichever Slack workspace the stored
 * credentials point at, but the key only carries the assistant id — so
 * every path that changes those credentials (save, disconnect) must drop
 * the cache via {@link memberSlackChannelsQueryKey} to avoid showing the
 * previous workspace's channels while a refetch runs.
 */
import type { QueryClient } from "@tanstack/react-query";

import { slackRosterQueryKey } from "@/domains/contacts/slack-users-query";
import {
  slackChannelsGetOptions,
  slackChannelsGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";

function memberChannelsRequestOptions(assistantId: string) {
  return {
    path: { assistant_id: assistantId },
    // Member-only is the product contract for the presence list (no toggle).
    query: { memberOnly: "true" } as const,
  };
}

export function memberSlackChannelsOptions(assistantId: string) {
  return slackChannelsGetOptions(memberChannelsRequestOptions(assistantId));
}

export function memberSlackChannelsQueryKey(assistantId: string) {
  return slackChannelsGetQueryKey(memberChannelsRequestOptions(assistantId));
}

/**
 * Drop every Slack-workspace-scoped cache (member channel list + user
 * roster). Both are scoped to whichever workspace the stored credentials
 * point at, so every path that changes those credentials (save, disconnect)
 * must call this — serving either cache across a reconnect would misreport
 * the previous workspace's channels/members.
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
