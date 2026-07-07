import { getConfig } from "../../../config/loader.js";
import type { ExternalConversationBinding } from "../../../persistence/external-conversation-store.js";
import type { ChannelBindingMetadata } from "../../channel-binding-schema.js";
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
 * The return type is derived from the channel-binding Zod schema
 * (`ChannelBindingMetadata`) — the single source of truth that also drives
 * `openapi.yaml` and the web client's generated types — so this builder cannot
 * drift from the wire contract. Slack is the only channel that can currently
 * produce message-level deep links, because the link inputs (workspace team
 * id/url + a stable per-message timestamp) only exist for Slack.
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

  // Channel-neutral source link: prefer the bound thread, fall back to the
  // channel, so clients land on the most specific source available.
  const sourceLink =
    threadLink ?? (channelWebUrl ? { webUrl: channelWebUrl } : undefined);

  return {
    externalChatName,
    ...(slackThread ? { slackThread } : {}),
    slackChannel: {
      channelId: binding.externalChatId,
      name: externalChatName,
      ...(channelWebUrl ? { link: { webUrl: channelWebUrl } } : {}),
    },
    ...(sourceLink ? { sourceLink } : {}),
  };
}
