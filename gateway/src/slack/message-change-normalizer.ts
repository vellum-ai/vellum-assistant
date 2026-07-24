import { isSlackDmChannel } from "./channel.js";
import {
  slackMessageChangedEventSchema,
  slackMessageDeletedEventSchema,
  type NormalizedSlackEvent,
} from "./message-schemas.js";
import {
  renderSlackInboundText,
  type SlackTextRenderContext,
} from "./render-text.js";
import type { GatewayConfig } from "../config.js";
import { resolveAssistant, isRejection } from "../routing/resolve-assistant.js";

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
