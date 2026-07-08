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
