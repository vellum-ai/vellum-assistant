import { resolveSlackUserSync } from "./user-directory.js";
import {
  slackMessageEventSchema,
  type SlackMessageEvent,
  type NormalizedSlackEvent,
} from "./message-schemas.js";
import {
  renderSlackInboundText,
  type SlackTextRenderContext,
} from "./render-text.js";
import { slackUserActorFields, slackBotSenderInfo } from "./actor.js";
import { extractSlackAttachments, extractSlackFileMap } from "./attachments.js";
import type { ChannelConversationType } from "@vellumai/gateway-client";
import type { GatewayConfig } from "../config.js";
import { resolveAssistant, isRejection } from "../routing/resolve-assistant.js";
import type { RouteResult } from "../routing/types.js";

/**
 * Message subtypes that are still a person saying something. Plain messages
 * omit `subtype`. `file_share` is an upload. `thread_broadcast` is a thread
 * reply that was also posted to the channel. Edits, deletes, and bot/system
 * subtypes have their own paths or are dropped.
 */
const ADMITTED_MESSAGE_SUBTYPES = new Set(["file_share", "thread_broadcast"]);

/** True when `subtype` is present and is not a human message we ingest. */
export function isIgnoredSlackMessageSubtype(
  subtype: string | undefined,
): boolean {
  return subtype !== undefined && !ADMITTED_MESSAGE_SUBTYPES.has(subtype);
}

/** The per-event-type differences across the plain-message normalizers. */
type SlackMessageShape = {
  /**
   * `source.chatType`; omitted for `app_mention`, which Slack sends without
   * saying which kind of room it came from. `group` is Slack's word for a
   * private channel, forwarded distinctly so the permission matrix can tell a
   * private room from a public one.
   */
  chatType?: "im" | "channel" | "group" | "mpim";
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

  // Ids are carried as-is — resolving them to names is the daemon's job, where
  // the channel cache lives, not a hot ingress path. The schema collapses a
  // malformed entity to `undefined` in place, so drop the holes and keep its
  // valid siblings. An empty context (Slack sends `{}` rather than omitting the
  // field) collapses to undefined.
  const appContextEntities = (event.app_context?.entities ?? [])
    .filter((entity) => entity !== undefined)
    .map((entity) => ({
      type: entity.type,
      value:
        typeof entity.value === "string"
          ? entity.value
          : {
              ...(entity.value.message_ts
                ? { messageTs: entity.value.message_ts }
                : {}),
              ...(entity.value.channel_id
                ? { channelId: entity.value.channel_id }
                : {}),
            },
      ...(entity.team_id ? { teamId: entity.team_id } : {}),
      ...(entity.enterprise_id ? { enterpriseId: entity.enterprise_id } : {}),
    }));
  const appContext = appContextEntities.length
    ? { entities: appContextEntities }
    : undefined;

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
        ...(slackConversationType(shape.chatType)
          ? { conversationType: slackConversationType(shape.chatType) }
          : {}),
        ...(event.thread_ts ? { threadId: event.thread_ts } : {}),
        ...(appContext ? { appContext } : {}),
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

/**
 * Normalize a Slack 1:1 DM (`message` with `channel_type: "im"`) into the
 * gateway's canonical inbound event shape. Used for guardian verification
 * code replies and direct conversations with the bot. Group DMs have their own
 * normalizer, see {@link normalizeSlackGroupDirectMessage}.
 *
 * Returns null if the event cannot be routed or should be ignored
 * (e.g. subtypes like message_changed, missing user).
 *
 * Bot's own messages are dropped by `processEventPayload` before
 * normalization.
 */
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

  // Only plain user messages, uploads, and thread broadcasts. Edits/deletes
  // have their own normalizers.
  if (isIgnoredSlackMessageSubtype(msg.subtype)) return null;
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
    { chatType: "im", stampTeam: false, fallbackThreadToTs: false },
    botToken,
    renderContext,
  );
}

/**
 * Normalize a Slack multi-person IM (`message` with `channel_type: "mpim"`)
 * into the gateway's canonical inbound event shape.
 *
 * Shares the DM family's admission semantics (every message in a group DM is
 * addressed to its participants, so no @-mention or tracked thread is needed)
 * but forwards `chatType: "mpim"` rather than collapsing it to `im`. The
 * daemon reads that value directly: `isGroupChatType` injects group-chat
 * etiquette for it, and `slackConversationType` resolves it to the
 * `private` permission-matrix cell. Reporting `im` for a multi-party room
 * would suppress the etiquette and select the looser `dm` cell.
 *
 * `fallbackThreadToTs` is false, matching DMs and not channels: an MPIM is one
 * continuous conversation, so top-level messages must share a conversation
 * rather than each minting a thread-scoped one.
 *
 * `stampTeam` is true, matching channels and not DMs: an MPIM is multi-party
 * and can include Slack Connect participants from another workspace, so the
 * sender's team is a real trust signal here in a way it is not in a 1:1 IM
 * with a known contact.
 *
 * Bot's own messages are dropped by `processEventPayload` before
 * normalization.
 */
export function normalizeSlackGroupDirectMessage(
  event: unknown,
  eventId: string,
  config: GatewayConfig,
  botToken?: string,
  renderContext?: SlackTextRenderContext,
): NormalizedSlackEvent | null {
  const parsed = slackMessageEventSchema.safeParse(event);
  if (!parsed.success) return null;
  const msg = parsed.data;

  if (isIgnoredSlackMessageSubtype(msg.subtype)) return null;
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
    { chatType: "mpim", stampTeam: true, fallbackThreadToTs: false },
    botToken,
    renderContext,
  );
}

/**
 * How visible a Slack conversation is, on the permission matrix's axis.
 *
 * Slack is the one channel that can answer this from the event alone, because
 * it names a private channel `group` and a public one `channel`. Everything
 * that cannot be proven public is reported private by
 * {@link slackChannelChatType} upstream, so this never has to guess.
 */
export function slackConversationType(
  chatType: "im" | "channel" | "group" | "mpim" | undefined,
): ChannelConversationType | undefined {
  switch (chatType) {
    case "im":
      return "dm";
    case "mpim":
    case "group":
      return "private";
    case "channel":
      return "public";
    default:
      return undefined;
  }
}

/**
 * Which kind of channel a non-DM Slack message came from.
 *
 * Slack distinguishes a public channel (`channel`) from a private one
 * (`group`), and collapsing the two is what kept the permission matrix's public
 * tier from ever matching: a permissive public-channel rule must never be
 * allowed to govern a private room, so an uncertain answer has to read as
 * private rather than public.
 *
 * Two signals, the same composition {@link isSlackDmChannel} uses, because
 * neither is always present. `channel_type` is authoritative but Slack omits it
 * on thread replies, edits and deletes. A `G` prefix marks a private channel
 * and is always present; `G` is shared with multi-person IMs, which reach their
 * own normalizer rather than this one, so within this path it means private.
 *
 * @see https://api.slack.com/types/conversation
 */
export function slackChannelChatType(
  channelId: string | undefined,
  channelType?: string,
): "channel" | "group" {
  if (channelType === "group") return "group";
  if (channelType === "channel") return "channel";
  return typeof channelId === "string" && channelId.startsWith("G")
    ? "group"
    : "channel";
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

  // file_share (uploads) and thread_broadcast (also-send-to-channel replies)
  // are still human messages.
  if (isIgnoredSlackMessageSubtype(msg.subtype)) return null;
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
    {
      chatType: slackChannelChatType(msg.channel, msg.channel_type),
      stampTeam: true,
      fallbackThreadToTs: true,
    },
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
