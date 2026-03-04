import type { GatewayConfig } from "../config.js";
import { resolveAssistant, isRejection } from "../routing/resolve-assistant.js";
import type { RouteResult } from "../routing/types.js";
import type { GatewayInboundEvent } from "../types.js";

/**
 * Slack `app_mention` event shape (subset relevant to normalization).
 */
export interface SlackAppMentionEvent {
  type: "app_mention";
  user: string;
  text: string;
  ts: string;
  channel: string;
  thread_ts?: string;
  client_msg_id?: string;
  event_ts?: string;
}

/**
 * Slack `message` event shape for direct messages (IMs).
 */
export interface SlackDirectMessageEvent {
  type: "message";
  subtype?: string;
  user?: string;
  text: string;
  ts: string;
  channel: string;
  channel_type: "im";
  thread_ts?: string;
  client_msg_id?: string;
  event_ts?: string;
}

/**
 * Slack `message` event shape for channel/group messages (non-DM).
 * Used to pick up thread replies in threads the bot is already participating in.
 */
export interface SlackChannelMessageEvent {
  type: "message";
  subtype?: string;
  user?: string;
  text: string;
  ts: string;
  channel: string;
  channel_type: "channel" | "group" | "mpim";
  thread_ts?: string;
  client_msg_id?: string;
  event_ts?: string;
}

/**
 * Slack `message_changed` event shape — subtype `message_changed` wraps the
 * edited message in `event.message` and the prior version in
 * `event.previous_message`.
 */
export interface SlackMessageChangedEvent {
  type: "message";
  subtype: "message_changed";
  channel: string;
  channel_type?: "im" | "channel" | "group" | "mpim";
  hidden?: boolean;
  ts: string;
  event_ts?: string;
  message: {
    user?: string;
    text: string;
    ts: string;
    client_msg_id?: string;
    thread_ts?: string;
  };
  previous_message?: {
    user?: string;
    text: string;
    ts: string;
  };
}

/**
 * Strip leading bot-mention tokens (`<@U...>`) from the message text.
 * Slack wraps mentions as `<@UXXXXXX>`, often at the start of an
 * app_mention event's text field. We remove all leading occurrences
 * so the assistant receives clean user content.
 */
export function stripBotMention(text: string): string {
  const stripped = text.replace(/^(<@[A-Z0-9]+>\s*)+/i, "").trim();
  return stripped || text.trim();
}

export type NormalizedSlackEvent = {
  event: GatewayInboundEvent;
  routing: RouteResult;
  /** Thread timestamp for reply threading. */
  threadTs: string;
  /** Slack channel ID. */
  channel: string;
};

/**
 * Normalize a Slack DM (`message` with `channel_type: "im"`) into the
 * gateway's canonical inbound event shape. Used for guardian verification
 * code replies and direct conversations with the bot.
 *
 * Returns null if the event cannot be routed or should be ignored
 * (e.g. bot's own messages, subtypes like message_changed).
 */
export function normalizeSlackDirectMessage(
  event: SlackDirectMessageEvent,
  eventId: string,
  config: GatewayConfig,
  botUserId?: string,
): NormalizedSlackEvent | null {
  // Ignore messages from the bot itself
  if (botUserId && event.user === botUserId) return null;
  // Ignore message subtypes (edits, deletions, etc.) — only handle plain user messages.
  // message_changed is handled separately by normalizeSlackMessageEdit.
  if (event.subtype) return null;
  // user is required for routing
  if (!event.user) return null;

  // DMs are always directed at the bot, so use the default assistant even
  // when the DM channel ID (D...) isn't in the routing table. This ensures
  // guardian verification replies aren't silently dropped.
  let routing = resolveAssistant(config, event.channel, event.user);
  if (isRejection(routing) && config.defaultAssistantId) {
    routing = {
      assistantId: config.defaultAssistantId,
      routeSource: "default" as const,
    };
  }
  if (isRejection(routing)) {
    return null;
  }

  const externalMessageId =
    event.client_msg_id ?? event.ts ?? `${event.channel}:${event.ts}`;

  return {
    event: {
      version: "v1",
      sourceChannel: "slack",
      receivedAt: new Date().toISOString(),
      message: {
        content: event.text,
        conversationExternalId: event.channel,
        externalMessageId,
      },
      actor: {
        actorExternalId: event.user,
      },
      source: {
        updateId: eventId,
      },
      raw: event as unknown as Record<string, unknown>,
    },
    routing,
    threadTs: event.thread_ts ?? event.ts,
    channel: event.channel,
  };
}

/**
 * Normalize a Slack channel `message` event (thread reply in an active bot
 * thread) into the gateway's canonical inbound event shape.
 *
 * Returns null if the event should be ignored (bot's own messages, subtypes,
 * missing user, or unroutable channels).
 */
export function normalizeSlackChannelMessage(
  event: SlackChannelMessageEvent,
  eventId: string,
  config: GatewayConfig,
  botUserId?: string,
): NormalizedSlackEvent | null {
  if (botUserId && event.user === botUserId) return null;
  if (event.subtype) return null;
  if (!event.user) return null;

  const routing = resolveAssistant(config, event.channel, event.user);
  if (isRejection(routing)) return null;

  const content = stripBotMention(event.text);
  const externalMessageId =
    event.client_msg_id ?? event.ts ?? `${event.channel}:${event.ts}`;

  return {
    event: {
      version: "v1",
      sourceChannel: "slack",
      receivedAt: new Date().toISOString(),
      message: {
        content,
        conversationExternalId: event.channel,
        externalMessageId,
      },
      actor: {
        actorExternalId: event.user,
      },
      source: {
        updateId: eventId,
        chatType: "channel",
      },
      raw: event as unknown as Record<string, unknown>,
    },
    routing,
    threadTs: event.thread_ts ?? event.ts,
    channel: event.channel,
  };
}

/**
 * Normalize a Slack `app_mention` event into the gateway's
 * canonical inbound event shape, matching the pattern used by
 * the Telegram normalizer.
 *
 * Returns null if the event cannot be routed.
 */
export function normalizeSlackAppMention(
  event: SlackAppMentionEvent,
  eventId: string,
  config: GatewayConfig,
): NormalizedSlackEvent | null {
  const routing = resolveAssistant(config, event.channel, event.user);
  if (isRejection(routing)) {
    return null;
  }

  const content = stripBotMention(event.text);
  const externalMessageId =
    event.client_msg_id ?? event.ts ?? `${event.channel}:${event.ts}`;

  return {
    event: {
      version: "v1",
      sourceChannel: "slack",
      receivedAt: new Date().toISOString(),
      message: {
        content,
        conversationExternalId: event.channel,
        externalMessageId,
      },
      actor: {
        actorExternalId: event.user,
      },
      source: {
        updateId: eventId,
      },
      raw: event as unknown as Record<string, unknown>,
    },
    routing,
    threadTs: event.thread_ts ?? event.ts,
    channel: event.channel,
  };
}

/**
 * Slack `block_actions` interactive payload shape (subset relevant to normalization).
 * Sent when a user clicks a Block Kit interactive element (button, menu, etc.).
 */
export interface SlackBlockActionsPayload {
  type: "block_actions";
  trigger_id: string;
  user: { id: string; username?: string; name?: string };
  channel?: { id: string; name?: string };
  message?: { ts: string; text?: string };
  actions: Array<{
    action_id: string;
    value?: string;
    type: string;
    block_id?: string;
    action_ts?: string;
  }>;
}

/**
 * Slack `reaction_added` event shape.
 */
export interface SlackReactionAddedEvent {
  type: "reaction_added";
  user: string;
  reaction: string;
  item: {
    type: string;
    channel: string;
    ts: string;
  };
  item_user?: string;
  event_ts?: string;
}

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
  payload: SlackBlockActionsPayload,
  envelopeId: string,
  config: GatewayConfig,
): NormalizedSlackEvent | null {
  const action = payload.actions?.[0];
  if (!action) return null;

  const userId = payload.user?.id;
  if (!userId) return null;

  const channelId = payload.channel?.id;
  if (!channelId) return null;

  const routing = resolveAssistant(config, channelId, userId);
  if (isRejection(routing)) return null;

  const callbackData = action.value ?? action.action_id;
  const messageTs = payload.message?.ts;
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
        callbackQueryId: payload.trigger_id,
        callbackData,
      },
      actor: {
        actorExternalId: userId,
        username: payload.user.username,
        displayName: payload.user.name,
      },
      source: {
        updateId: envelopeId,
        messageId: messageTs,
      },
      raw: payload as unknown as Record<string, unknown>,
    },
    routing,
    threadTs: messageTs ?? envelopeId,
    channel: channelId,
  };
}

/**
 * Normalize a Slack `reaction_added` event into the gateway's canonical
 * inbound event shape. The reaction emoji name is placed in `callbackData`
 * so downstream handlers can process it like a callback action.
 *
 * Returns null if the event is missing required fields or cannot be routed.
 */
export function normalizeSlackReactionAdded(
  event: SlackReactionAddedEvent,
  eventId: string,
  config: GatewayConfig,
): NormalizedSlackEvent | null {
  if (!event.user || !event.item?.channel || !event.item?.ts) return null;

  const routing = resolveAssistant(config, event.item.channel, event.user);
  if (isRejection(routing)) return null;

  const callbackData = `reaction:${event.reaction}`;

  return {
    event: {
      version: "v1",
      sourceChannel: "slack",
      receivedAt: new Date().toISOString(),
      message: {
        content: callbackData,
        conversationExternalId: event.item.channel,
        externalMessageId: `${event.item.channel}:${event.item.ts}:${event.reaction}`,
        callbackData,
      },
      actor: {
        actorExternalId: event.user,
      },
      source: {
        updateId: eventId,
        messageId: event.item.ts,
      },
      raw: event as unknown as Record<string, unknown>,
    },
    routing,
    threadTs: event.item.ts,
    channel: event.item.channel,
  };
}

/**
 * Normalize a Slack `message_changed` event into the gateway's canonical
 * inbound event shape with `isEdit: true`.
 *
 * The edited content lives in `event.message` (not `event.previous_message`).
 * Uses `event.message.ts` as `source.messageId` so the runtime can correlate
 * the edit with the original message. The `externalMessageId` is unique per
 * edit (eventId) to avoid dedup collisions across successive edits.
 *
 * Returns null if the event should be ignored (bot's own edits, missing user,
 * or unroutable channels).
 */
export function normalizeSlackMessageEdit(
  event: SlackMessageChangedEvent,
  eventId: string,
  config: GatewayConfig,
  botUserId?: string,
): NormalizedSlackEvent | null {
  const edited = event.message;
  if (!edited) return null;

  // Ignore edits from the bot itself
  if (botUserId && edited.user === botUserId) return null;
  // user is required for routing
  if (!edited.user) return null;

  // Try channel routing, fall back to default for DMs
  const isDm = event.channel_type === "im";
  let routing = resolveAssistant(config, event.channel, edited.user);
  if (isRejection(routing) && isDm && config.defaultAssistantId) {
    routing = {
      assistantId: config.defaultAssistantId,
      routeSource: "default" as const,
    };
  }
  if (isRejection(routing)) return null;

  const content = stripBotMention(edited.text);

  // Each edit event gets a unique externalMessageId so the dedup pipeline
  // does not discard subsequent edits of the same Slack message.
  const externalMessageId = eventId;

  return {
    event: {
      version: "v1",
      sourceChannel: "slack",
      receivedAt: new Date().toISOString(),
      message: {
        content,
        conversationExternalId: event.channel,
        externalMessageId,
        isEdit: true,
      },
      actor: {
        actorExternalId: edited.user,
      },
      source: {
        updateId: eventId,
        // The original message's ts lets the runtime identify which message was edited
        messageId: edited.ts,
        ...(isDm ? {} : { chatType: "channel" }),
      },
      raw: event as unknown as Record<string, unknown>,
    },
    routing,
    // Fall back to the original message ts, not the wrapper event ts
    threadTs: edited.thread_ts ?? edited.ts,
    channel: event.channel,
  };
}
