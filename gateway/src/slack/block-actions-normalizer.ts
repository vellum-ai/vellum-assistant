import { isSlackDmChannel } from "./channel.js";
import {
  slackBlockActionsPayloadSchema,
  type NormalizedSlackEvent,
} from "./message-schemas.js";
import type { GatewayConfig } from "../config.js";
import { resolveAssistant, isRejection } from "../routing/resolve-assistant.js";

/**
 * Normalize a Slack `block_actions` interactive payload into the gateway's
 * canonical inbound event shape, matching Telegram's `callback_query` pattern.
 *
 * Uses the first action in the `actions` array. The `callbackData` field is
 * set to match the Telegram `apr:{requestId}:{actionId}` convention when the
 * action value follows that pattern, or falls back to the raw action value.
 *
 * Returns null if the payload is missing required fields or cannot be routed.
 */
export function normalizeSlackBlockActions(
  payload: unknown,
  envelopeId: string,
  config: GatewayConfig,
): NormalizedSlackEvent | null {
  const parsed = slackBlockActionsPayloadSchema.safeParse(payload);
  if (!parsed.success) return null;
  const data = parsed.data;

  const action = data.actions?.[0];
  if (!action) return null;

  // The action's value / id is the callback content and dedup payload; an
  // action carrying neither is unactionable, so drop it.
  const callbackData = action.value ?? action.action_id;
  if (!callbackData) return null;

  const userId = data.user?.id;
  if (!userId) return null;

  const channelId = data.channel?.id;
  if (!channelId) return null;

  // DM channels (D...) fall back to the default assistant when the DM
  // channel ID isn't in the routing table — consistent with the fallback in
  // normalizeSlackDirectMessage, normalizeSlackReaction, and the message
  // edit/delete normalizers. Without this, button clicks on guardian
  // notifications sent as DMs are silently dropped.
  let routing = resolveAssistant(config, channelId, userId);
  if (
    isRejection(routing) &&
    config.defaultAssistantId &&
    isSlackDmChannel(channelId)
  ) {
    routing = {
      assistantId: config.defaultAssistantId,
      routeSource: "default" as const,
    };
  }
  if (isRejection(routing)) return null;

  const messageTs = data.message?.ts;
  // Use action_ts (unique per click) to prevent dedup collisions when
  // multiple buttons on the same message are clicked or the same button
  // is clicked again after a transient failure.
  const actionTs = action.action_ts ?? envelopeId;

  return {
    event: {
      version: "v1",
      sourceChannel: "slack",
      receivedAt: new Date().toISOString(),
      message: {
        content: callbackData,
        conversationExternalId: channelId,
        externalMessageId: `${channelId}:${messageTs ?? envelopeId}:${actionTs}`,
        callbackQueryId: data.trigger_id,
        callbackData,
      },
      actor: {
        actorExternalId: userId,
        username: data.user?.username,
        displayName: data.user?.name,
      },
      source: {
        updateId: envelopeId,
        messageId: messageTs,
        ...(data.message?.thread_ts
          ? { threadId: data.message.thread_ts }
          : {}),
      },
      raw: payload as Record<string, unknown>,
    },
    routing,
    // Prefer the thread root so follow-up messages land in the original
    // conversation thread, not a reply's sub-thread.
    threadTs: data.message?.thread_ts ?? messageTs ?? envelopeId,
    channel: channelId,
  };
}
