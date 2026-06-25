import { getConfig } from "../../../config/loader.js";
import type { ExternalConversationBinding } from "../../../memory/external-conversation-store.js";
import type { ChannelBindingMetadata } from "../../provider-types.js";
import {
  buildSlackMessageDeepLinks,
  buildSlackWebChannelUrl,
} from "./deep-link.js";

/**
 * Slack's contribution to a serialized conversation channel binding: a
 * human-readable channel name (falling back to the channel id) plus deep
 * links that jump back to the source thread and channel in the Slack app or
 * web client.
 *
 * The returned fields are spread onto the channel-neutral binding by the
 * serializer — Slack is the only channel that can currently produce
 * message-level deep links, because the link inputs (workspace team id/url +
 * a stable per-message timestamp) only exist for Slack.
 */
export function buildSlackBindingMetadata(
  binding: ExternalConversationBinding,
): ChannelBindingMetadata {
  const externalChatName =
    binding.externalChatName?.trim() || binding.externalChatId;
  const slackConfig = getConfig().slack;

  const threadLink =
    slackConfig && binding.externalThreadId
      ? buildSlackMessageDeepLinks({
          teamId: slackConfig.teamId,
          teamUrl: slackConfig.teamUrl,
          channelId: binding.externalChatId,
          messageTs: binding.externalThreadId,
        })
      : undefined;
  const slackThread = binding.externalThreadId
    ? {
        channelId: binding.externalChatId,
        threadTs: binding.externalThreadId,
        ...(threadLink ? { link: threadLink } : {}),
      }
    : undefined;

  const channelWebUrl = slackConfig
    ? buildSlackWebChannelUrl({
        teamUrl: slackConfig.teamUrl,
        channelId: binding.externalChatId,
      })
    : undefined;

  return {
    externalChatName,
    ...(slackThread ? { slackThread } : {}),
    slackChannel: {
      channelId: binding.externalChatId,
      name: externalChatName,
      ...(channelWebUrl ? { link: { webUrl: channelWebUrl } } : {}),
    },
  };
}
