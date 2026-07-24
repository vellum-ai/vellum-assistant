import { isSlackDmChannel } from "./channel.js";
import { resolveSlackUserSync } from "./user-directory.js";
import {
  slackMessageEventSchema,
  slackMessageChangedEventSchema,
  slackMessageDeletedEventSchema,
  slackReactionEventSchema,
  slackBlockActionsPayloadSchema,
  type SlackMessageEvent,
  type SlackReactionEvent,
  type NormalizedSlackEvent,
} from "./message-schemas.js";
import {
  renderSlackInboundText,
  type SlackTextRenderContext,
} from "./render-text.js";
import { slackUserActorFields, slackBotSenderInfo } from "./actor.js";
import { extractSlackAttachments, extractSlackFileMap } from "./attachments.js";
import type { GatewayConfig } from "../config.js";
import { resolveAssistant, isRejection } from "../routing/resolve-assistant.js";
import type { RouteResult } from "../routing/types.js";

/**
 * Normalize a Slack DM (`message` with `channel_type: "im"`) into the
 * gateway's canonical inbound event shape. Used for guardian verification
 * code replies and direct conversations with the bot.
 *
 * Returns null if the event cannot be routed or should be ignored
 * (e.g. subtypes like message_changed, missing user).
 *
 * Bot's own messages are dropped by `processEventPayload` before
 * normalization.
 */
/** The per-event-type differences across the plain-message normalizers. */
type SlackMessageShape = {
  /** `source.chatType`; omitted for `app_mention`. */
  chatType?: "im" | "channel";
  /** Stamp the sender's workspace id onto the actor (channel + app_mention). */
  stampTeam: boolean;
  /** Reply in the message's own ts when it has no `thread_ts` (channel + app_mention). */
  fallbackThreadToTs: boolean;
};

/**
 * Shared construction for the plain-message family (`app_mention` / DM /
 * channel). Each caller owns its own guards, routing, and identity extraction;
 * this builds the canonical normalized event they all produce, so the three
 * public normalizers stay thin variant wrappers.
 */
function buildNormalizedSlackMessage(
  event: SlackMessageEvent,
  rawEvent: Record<string, unknown>,
  eventId: string,
  routing: RouteResult,
  channel: string,
  actorId: string,
  shape: SlackMessageShape,
  botToken?: string,
  renderContext?: SlackTextRenderContext,
): NormalizedSlackEvent {
  const externalMessageId =
    event.client_msg_id ?? event.ts ?? `${channel}:${event.ts}`;
  const attachments = extractSlackAttachments(event.files);
  const slackFiles = extractSlackFileMap(event.files);

  // Cache-only lookup to avoid blocking normalization on network calls; a
  // background fetch warms the cache for subsequent messages from this user.
  const userInfo = botToken
    ? resolveSlackUserSync(actorId, botToken)
    : undefined;
  const botSender = slackBotSenderInfo(event, userInfo);
  const content = renderSlackInboundText(event.text ?? "", renderContext);
  const threadTs =
    event.thread_ts ?? (shape.fallbackThreadToTs ? event.ts : undefined);

  return {
    event: {
      version: "v1",
      sourceChannel: "slack",
      receivedAt: new Date().toISOString(),
      message: {
        content,
        conversationExternalId: channel,
        externalMessageId,
        ...(attachments.length > 0 ? { attachments } : {}),
      },
      actor: {
        actorExternalId: actorId,
        ...(userInfo ? slackUserActorFields(userInfo) : {}),
        ...(shape.stampTeam && event.team ? { teamId: event.team } : {}),
        ...(botSender ? { isBot: true } : {}),
      },
      source: {
        updateId: eventId,
        messageId: event.ts,
        ...(shape.chatType ? { chatType: shape.chatType } : {}),
        ...(event.thread_ts ? { threadId: event.thread_ts } : {}),
      },
      raw: rawEvent,
    },
    routing,
    ...(threadTs ? { threadTs } : {}),
    channel,
    ...(slackFiles ? { slackFiles } : {}),
    ...(botSender ? { botSender } : {}),
  };
}

export function normalizeSlackDirectMessage(
  event: unknown,
  eventId: string,
  config: GatewayConfig,
  botToken?: string,
  renderContext?: SlackTextRenderContext,
): NormalizedSlackEvent | null {
  const parsed = slackMessageEventSchema.safeParse(event);
  if (!parsed.success) return null;
  const msg = parsed.data;

  // Only plain user messages; file_share carries uploads. Edits/deletes have
  // their own normalizers.
  if (msg.subtype && msg.subtype !== "file_share") return null;
  if (!msg.user || !msg.channel || !msg.ts) return null;

  // DMs are always directed at the bot, so fall back to the default assistant
  // even when the DM channel id isn't in the routing table — otherwise guardian
  // verification replies would be silently dropped.
  let routing = resolveAssistant(config, msg.channel, msg.user);
  if (isRejection(routing) && config.defaultAssistantId) {
    routing = {
      assistantId: config.defaultAssistantId,
      routeSource: "default" as const,
    };
  }
  if (isRejection(routing)) return null;

  return buildNormalizedSlackMessage(
    msg,
    event as Record<string, unknown>,
    eventId,
    routing,
    msg.channel,
    msg.user,
    { chatType: "im", stampTeam: false, fallbackThreadToTs: false },
    botToken,
    renderContext,
  );
}

/**
 * Normalize a Slack channel `message` event (thread reply in an active bot
 * thread) into the gateway's canonical inbound event shape.
 *
 * Returns null if the event should be ignored (subtypes, missing user/channel,
 * or unroutable channels).
 *
 * Bot's own messages are dropped by `processEventPayload` before
 * normalization.
 */
export function normalizeSlackChannelMessage(
  event: unknown,
  eventId: string,
  config: GatewayConfig,
  botToken?: string,
  renderContext?: SlackTextRenderContext,
): NormalizedSlackEvent | null {
  const parsed = slackMessageEventSchema.safeParse(event);
  if (!parsed.success) return null;
  const msg = parsed.data;

  // file_share is allowed so image/file uploads are delivered to the assistant.
  if (msg.subtype && msg.subtype !== "file_share") return null;
  if (!msg.user || !msg.channel || !msg.ts) return null;

  const routing = resolveAssistant(config, msg.channel, msg.user);
  if (isRejection(routing)) return null;

  return buildNormalizedSlackMessage(
    msg,
    event as Record<string, unknown>,
    eventId,
    routing,
    msg.channel,
    msg.user,
    { chatType: "channel", stampTeam: true, fallbackThreadToTs: true },
    botToken,
    renderContext,
  );
}

/**
 * Normalize a Slack `app_mention` event into the gateway's canonical inbound
 * event shape, matching the pattern used by the Telegram normalizer.
 *
 * Returns null if the event is missing identity fields or cannot be routed.
 */
export function normalizeSlackAppMention(
  event: unknown,
  eventId: string,
  config: GatewayConfig,
  botToken?: string,
  renderContext?: SlackTextRenderContext,
): NormalizedSlackEvent | null {
  const parsed = slackMessageEventSchema.safeParse(event);
  if (!parsed.success) return null;
  const msg = parsed.data;

  if (!msg.user || !msg.channel || !msg.ts) return null;

  const routing = resolveAssistant(config, msg.channel, msg.user);
  if (isRejection(routing)) return null;

  return buildNormalizedSlackMessage(
    msg,
    event as Record<string, unknown>,
    eventId,
    routing,
    msg.channel,
    msg.user,
    { stampTeam: true, fallbackThreadToTs: true },
    botToken,
    renderContext,
  );
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

/**
 * Shared normalizer for Slack reaction events. Both `reaction_added` and
 * `reaction_removed` carry the same payload shape and differ only in the
 * downstream callback prefix and externalMessageId suffix.
 */
function normalizeSlackReaction(
  event: SlackReactionEvent,
  rawEvent: Record<string, unknown>,
  eventId: string,
  config: GatewayConfig,
  op: "added" | "removed",
): NormalizedSlackEvent | null {
  // `reaction` is load-bearing: it forms the `callbackData` and part of the
  // dedup `externalMessageId`. Without this guard a collapsed (missing /
  // non-string) reaction would emit `reaction:undefined`, which the
  // assistant-side parser treats as a real emoji named "undefined" rather
  // than dropping it.
  if (
    !event.user ||
    !event.reaction ||
    !event.item?.channel ||
    !event.item?.ts
  ) {
    return null;
  }

  const channel = event.item.channel;

  // DM reactions should still route via default assistant (same as DM messages).
  // Only apply fallback to DM channels (D...) — reactions from unrouted public
  // channels should not bypass explicit routing policy.
  let routing = resolveAssistant(config, channel, event.user);
  if (
    isRejection(routing) &&
    config.defaultAssistantId &&
    isSlackDmChannel(channel)
  ) {
    routing = {
      assistantId: config.defaultAssistantId,
      routeSource: "default" as const,
    };
  }
  if (isRejection(routing)) return null;

  const prefix = op === "added" ? "reaction" : "reaction_removed";
  const callbackData = `${prefix}:${event.reaction}`;
  // Include reactor user ID to prevent dedup collisions when multiple
  // users react with the same emoji on the same message. Append the op
  // suffix so an add and a subsequent remove of the same emoji by the
  // same user produce distinct externalMessageIds.
  const externalMessageId =
    op === "added"
      ? `${channel}:${event.item.ts}:${event.reaction}:${event.user}`
      : `${channel}:${event.item.ts}:${event.reaction}:${event.user}:removed`;

  return {
    event: {
      version: "v1",
      sourceChannel: "slack",
      receivedAt: new Date().toISOString(),
      message: {
        content: callbackData,
        conversationExternalId: channel,
        externalMessageId,
        callbackData,
      },
      actor: {
        actorExternalId: event.user,
      },
      source: {
        updateId: eventId,
        messageId: event.item.ts,
        threadId: event.item.ts,
      },
      raw: rawEvent,
    },
    routing,
    threadTs: event.item.ts,
    channel,
  };
}

/**
 * Normalize a Slack `reaction_added` event into the gateway's canonical
 * inbound event shape. The reaction emoji name is placed in `callbackData`
 * (prefixed with `reaction:`) so downstream handlers can process it like a
 * callback action.
 *
 * Returns null if the event is missing required fields or cannot be routed.
 */
export function normalizeSlackReactionAdded(
  event: unknown,
  eventId: string,
  config: GatewayConfig,
): NormalizedSlackEvent | null {
  const parsed = slackReactionEventSchema.safeParse(event);
  if (!parsed.success) return null;
  return normalizeSlackReaction(
    parsed.data,
    event as Record<string, unknown>,
    eventId,
    config,
    "added",
  );
}

/**
 * Normalize a Slack `reaction_removed` event into the gateway's canonical
 * inbound event shape. The emoji name is placed in `callbackData` with a
 * `reaction_removed:` prefix so downstream handlers can distinguish removals
 * from additions.
 *
 * Returns null if the event is missing required fields or cannot be routed.
 */
export function normalizeSlackReactionRemoved(
  event: unknown,
  eventId: string,
  config: GatewayConfig,
): NormalizedSlackEvent | null {
  const parsed = slackReactionEventSchema.safeParse(event);
  if (!parsed.success) return null;
  return normalizeSlackReaction(
    parsed.data,
    event as Record<string, unknown>,
    eventId,
    config,
    "removed",
  );
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
 * Returns null if the event should be ignored (missing user, unroutable
 * channels, or unchanged edit timestamps).
 *
 * Bot's own edits are dropped by `processEventPayload` before
 * normalization.
 */
export function normalizeSlackMessageEdit(
  event: unknown,
  eventId: string,
  config: GatewayConfig,
  renderContext?: SlackTextRenderContext,
): NormalizedSlackEvent | null {
  const parsed = slackMessageChangedEventSchema.safeParse(event);
  if (!parsed.success) return null;
  const changed = parsed.data;
  const rawEvent = event as Record<string, unknown>;

  const edited = changed.message;
  if (!edited) return null;

  const editTimestampUnchanged =
    changed.previous_message !== undefined &&
    changed.previous_message.edited?.ts === edited.edited?.ts;
  if (editTimestampUnchanged) return null;

  // channel (addressing), user (actor/routing), and the edited message's ts
  // (the correlation key the runtime uses to find the edited row) are the
  // fields this normalizer keys on; a collapsed one drops the event.
  if (!changed.channel || !edited.user || !edited.ts) return null;
  const channel = changed.channel;

  // Try channel routing, fall back to default for DMs so edits in DMs still
  // take the defaultAssistantId routing branch.
  const isDm = isSlackDmChannel(channel, changed.channel_type);
  let routing = resolveAssistant(config, channel, edited.user);
  if (isRejection(routing) && isDm && config.defaultAssistantId) {
    routing = {
      assistantId: config.defaultAssistantId,
      routeSource: "default" as const,
    };
  }
  if (isRejection(routing)) return null;

  const content = renderSlackInboundText(edited.text ?? "", renderContext);

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
        conversationExternalId: channel,
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
        ...(edited.thread_ts ? { threadId: edited.thread_ts } : {}),
      },
      raw: rawEvent,
    },
    routing,
    // For DMs without a thread, omit threadTs so the reply goes directly in conversation.
    // For channels (or DMs already in a thread), fall back to edited.ts.
    ...(isDm && !edited.thread_ts
      ? {}
      : { threadTs: edited.thread_ts ?? edited.ts }),
    channel,
  };
}

/**
 * Normalize a Slack `message_deleted` event into the gateway's canonical
 * inbound event shape.
 *
 * The deleted message's `ts` arrives as `event.deleted_ts` and the prior
 * content (including any `thread_ts`) lives in `event.previous_message`.
 * The daemon detects deletes via the `message_deleted` sentinel placed in
 * `callbackData` and uses `source.messageId` (= `deleted_ts`) to look up
 * the stored row. `message.content` is intentionally empty — the daemon
 * just marks the row deleted and does not re-process content.
 *
 * Each delete event gets a unique `externalMessageId` (= eventId) so the
 * dedup pipeline does not collide if Slack re-delivers the event.
 *
 * Returns null if the event cannot be routed.
 */
export function normalizeSlackMessageDelete(
  event: unknown,
  eventId: string,
  config: GatewayConfig,
): NormalizedSlackEvent | null {
  const parsed = slackMessageDeletedEventSchema.safeParse(event);
  if (!parsed.success) return null;
  const deleted = parsed.data;
  const rawEvent = event as Record<string, unknown>;

  // deleted_ts (the runtime's lookup key for the stored row) and channel
  // (addressing) are the fields this normalizer keys on.
  if (!deleted.deleted_ts || !deleted.channel) return null;
  const channel = deleted.channel;

  // Use the previous author for actor identity when available; otherwise fall
  // back to a synthetic identifier so routing/trust still has something to key on.
  const actorId = deleted.previous_message?.user ?? "slack-system";

  // Fall back to the default assistant for DMs so deletes from DMs still take
  // the defaultAssistantId routing branch.
  const isDm = isSlackDmChannel(channel, deleted.channel_type);
  let routing = resolveAssistant(config, channel, actorId);
  if (isRejection(routing) && isDm && config.defaultAssistantId) {
    routing = {
      assistantId: config.defaultAssistantId,
      routeSource: "default" as const,
    };
  }
  if (isRejection(routing)) return null;

  const previousThreadTs = deleted.previous_message?.thread_ts;

  return {
    event: {
      version: "v1",
      sourceChannel: "slack",
      receivedAt: new Date().toISOString(),
      message: {
        content: "",
        conversationExternalId: channel,
        // Unique per delete event to avoid dedup collisions
        externalMessageId: eventId,
        // Sentinel value the daemon uses to detect deletions
        callbackData: "message_deleted",
      },
      actor: {
        actorExternalId: actorId,
      },
      source: {
        updateId: eventId,
        // Original message's ts — the lookup key the daemon uses to find
        // the stored row to mark deleted.
        messageId: deleted.deleted_ts,
        ...(isDm ? {} : { chatType: "channel" }),
        ...(previousThreadTs ? { threadId: previousThreadTs } : {}),
      },
      raw: rawEvent,
    },
    routing,
    // Preserve thread context so downstream handling stays scoped to the
    // original conversation thread when applicable.
    ...(previousThreadTs ? { threadTs: previousThreadTs } : {}),
    channel,
  };
}
