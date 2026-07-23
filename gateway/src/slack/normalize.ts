import { renderSlackTextForModel } from "@vellumai/slack-text";
import type {
  GenericMessageEvent as SlackApiGenericMessageEvent,
  MessageChangedEvent as SlackApiMessageChangedEvent,
  MessageDeletedEvent as SlackApiMessageDeletedEvent,
  ReactionAddedEvent as SlackApiReactionAddedEvent,
  ReactionRemovedEvent as SlackApiReactionRemovedEvent,
} from "@slack/types";
import { createHash } from "node:crypto";
import { z } from "zod";
import { isSlackDmChannel } from "./channel.js";
import type { GatewayConfig } from "../config.js";
import { fetchImpl } from "../fetch.js";
import { resolveAssistant, isRejection } from "../routing/resolve-assistant.js";
import type { RouteResult } from "../routing/types.js";
import type { GatewayInboundEvent } from "../types.js";
import type {
  Expect,
  ModeledKeysAreOfficial,
  OfficialValueSatisfiesOurs,
} from "../webhook-crosscheck.js";

// Slack event payloads are untrusted external input (Socket Mode / Events API).
// Fields are validated with tolerant Zod schemas: a malformed value collapses to
// `undefined` so the existing null-checks drop an unprocessable event rather than
// trusting garbage. The original payload is preserved verbatim as `raw`.
const optionalString = () => z.string().optional().catch(undefined);

/**
 * Resolved Slack user info for populating actor fields.
 */
export interface SlackUserInfo {
  displayName: string;
  username: string;
  timezone?: string;
  timezoneLabel?: string;
  timezoneOffsetSeconds?: number;
  /** The sender is a bot user (Slack `users.info` `is_bot`). */
  isBot?: boolean;
  isStranger?: boolean;
  isRestricted?: boolean;
}

export type SlackUserActorFields = Pick<
  SlackUserInfo,
  | "displayName"
  | "username"
  | "timezone"
  | "timezoneLabel"
  | "timezoneOffsetSeconds"
  | "isBot"
  | "isStranger"
  | "isRestricted"
>;

interface SlackChannelInfo {
  name: string;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const USER_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const USER_CACHE_MAX_SIZE = 500;
const CHANNEL_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const CHANNEL_CACHE_MAX_SIZE = 500;

/**
 * In-memory LRU cache for Slack user info lookups.
 * Entries expire after TTL and the cache evicts least-recently-used
 * entries when it exceeds MAX_SIZE.
 */
const userInfoCache = new Map<string, CacheEntry<SlackUserInfo>>();
const channelInfoCache = new Map<string, CacheEntry<SlackChannelInfo>>();

/**
 * Deduplicates concurrent fetches for the same userId so only one
 * API call is made even when multiple messages arrive simultaneously.
 */
const inFlightUserFetches = new Map<
  string,
  Promise<SlackUserInfo | undefined>
>();
const inFlightChannelFetches = new Map<
  string,
  Promise<SlackChannelInfo | undefined>
>();

function slackUserCacheKey(userId: string, botToken: string): string {
  const authScope = createHash("sha256").update(botToken).digest("hex");
  return `${authScope}:${userId}`;
}

function slackChannelCacheKey(channelId: string, botToken: string): string {
  const authScope = createHash("sha256").update(botToken).digest("hex");
  return `${authScope}:${channelId}`;
}

function evictExpired<T>(cache: Map<string, CacheEntry<T>>): void {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) {
      cache.delete(key);
    }
  }
}

function cacheGet<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
): T | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  // Move to end for LRU ordering (Map preserves insertion order)
  cache.delete(key);
  cache.set(key, entry);
  return entry.value;
}

function cacheSet<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  value: T,
  ttlMs: number,
  maxSize: number,
): void {
  // Evict if over capacity
  if (cache.size >= maxSize) {
    evictExpired(cache);
    // If still over capacity, evict oldest entry
    if (cache.size >= maxSize) {
      const oldest = cache.keys().next().value;
      if (typeof oldest === "string") cache.delete(oldest);
    }
  }
  cache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
  });
}

/**
 * Resolve a Slack user's display name and username via `users.info`.
 * Results are cached to avoid repeated API calls.
 *
 * Returns undefined on failure — callers should treat display name as
 * best-effort and proceed without it.
 */
export async function resolveSlackUser(
  userId: string,
  botToken: string,
): Promise<SlackUserInfo | undefined> {
  const cacheKey = slackUserCacheKey(userId, botToken);
  const cached = cacheGet(userInfoCache, cacheKey);
  if (cached) return cached;

  // If another caller is already fetching this user, reuse that promise
  const existing = inFlightUserFetches.get(cacheKey);
  if (existing) return existing;

  const fetchPromise = (async (): Promise<SlackUserInfo | undefined> => {
    try {
      const resp = await fetchImpl(
        `https://slack.com/api/users.info?user=${encodeURIComponent(userId)}`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${botToken}` },
        },
      );
      if (!resp.ok) return undefined;

      const data = (await resp.json()) as {
        ok?: boolean;
        user?: {
          name?: string;
          real_name?: string;
          tz?: string;
          tz_label?: string;
          tz_offset?: number;
          is_bot?: boolean;
          is_stranger?: boolean;
          is_restricted?: boolean;
          is_ultra_restricted?: boolean;
          profile?: { display_name?: string; real_name?: string };
        };
      };
      if (!data.ok || !data.user) return undefined;

      const displayName =
        data.user.profile?.display_name ||
        data.user.real_name ||
        data.user.profile?.real_name ||
        data.user.name ||
        userId;
      const username = data.user.name || userId;
      const timezone =
        typeof data.user.tz === "string" ? data.user.tz : undefined;
      const timezoneLabel =
        typeof data.user.tz_label === "string" ? data.user.tz_label : undefined;
      const timezoneOffsetSeconds =
        typeof data.user.tz_offset === "number"
          ? data.user.tz_offset
          : undefined;

      // Explicit booleans, not presence flags: a successful users.info is a
      // positive identity resolution, so `false` means "Slack says this user
      // is a regular workspace member". When resolution fails these fields
      // are absent entirely (unknown), and downstream trust policy must fail
      // toward the handshake rather than treating the sender as vouched.
      const isBot = data.user.is_bot === true;
      const isStranger = data.user.is_stranger === true;
      const isRestricted =
        data.user.is_restricted === true ||
        data.user.is_ultra_restricted === true;

      const info: SlackUserInfo = {
        displayName,
        username,
        ...(timezone !== undefined ? { timezone } : {}),
        ...(timezoneLabel !== undefined ? { timezoneLabel } : {}),
        ...(timezoneOffsetSeconds !== undefined
          ? { timezoneOffsetSeconds }
          : {}),
        isBot,
        isStranger,
        isRestricted,
      };
      cacheSet(
        userInfoCache,
        cacheKey,
        info,
        USER_CACHE_TTL_MS,
        USER_CACHE_MAX_SIZE,
      );
      return info;
    } catch {
      return undefined;
    }
  })();

  inFlightUserFetches.set(cacheKey, fetchPromise);
  try {
    return await fetchPromise;
  } finally {
    inFlightUserFetches.delete(cacheKey);
  }
}

/**
 * Resolve a Slack channel name via `conversations.info`.
 * Results are cached to avoid repeated API calls.
 *
 * Returns undefined on failure so callers can fall back to
 * `#unknown-channel` without leaking raw channel IDs into model context.
 */
export async function resolveSlackChannel(
  channelId: string,
  botToken: string,
): Promise<SlackChannelInfo | undefined> {
  const cacheKey = slackChannelCacheKey(channelId, botToken);
  const cached = cacheGet(channelInfoCache, cacheKey);
  if (cached) return cached;

  const existing = inFlightChannelFetches.get(cacheKey);
  if (existing) return existing;

  const fetchPromise = (async (): Promise<SlackChannelInfo | undefined> => {
    try {
      const resp = await fetchImpl(
        `https://slack.com/api/conversations.info?channel=${encodeURIComponent(channelId)}`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${botToken}` },
        },
      );
      if (!resp.ok) return undefined;

      const data = (await resp.json()) as {
        ok?: boolean;
        channel?: {
          name?: string;
          name_normalized?: string;
        };
      };
      if (!data.ok || !data.channel) return undefined;

      const name = data.channel.name || data.channel.name_normalized;
      if (!name) return undefined;

      const info: SlackChannelInfo = { name };
      cacheSet(
        channelInfoCache,
        cacheKey,
        info,
        CHANNEL_CACHE_TTL_MS,
        CHANNEL_CACHE_MAX_SIZE,
      );
      return info;
    } catch {
      return undefined;
    }
  })();

  inFlightChannelFetches.set(cacheKey, fetchPromise);
  try {
    return await fetchPromise;
  } finally {
    inFlightChannelFetches.delete(cacheKey);
  }
}

/**
 * Cache-only user lookup for the hot normalization path.
 * Returns cached info immediately without making network calls.
 * Fires off a background fetch to warm the cache for next time.
 */
export function resolveSlackUserSync(
  userId: string,
  botToken: string,
): SlackUserInfo | undefined {
  const cacheKey = slackUserCacheKey(userId, botToken);
  const cached = cacheGet(userInfoCache, cacheKey);
  if (!cached && !inFlightUserFetches.has(cacheKey)) {
    // Fire-and-forget: warm the cache for next time
    resolveSlackUser(userId, botToken).catch(() => {});
  }
  return cached;
}

/** Exported for testing — clears the user info cache. */
export function clearUserInfoCache(): void {
  userInfoCache.clear();
}

/** Exported for testing — clears the channel info cache. */
export function clearChannelInfoCache(): void {
  channelInfoCache.clear();
}

/** Exported for testing — clears the in-flight fetch map. */
export function clearInFlightFetches(): void {
  inFlightUserFetches.clear();
  inFlightChannelFetches.clear();
}

/** Exported for testing — returns current cache size. */
export function getUserInfoCacheSize(): number {
  return userInfoCache.size;
}

/** Exported for testing — returns current channel cache size. */
export function getChannelInfoCacheSize(): number {
  return channelInfoCache.size;
}

/** Slack file object (subset relevant to attachment handling). */
export interface SlackFile {
  id: string;
  name?: string;
  mimetype?: string;
  size?: number;
  url_private_download?: string;
  url_private?: string;
}

/**
 * Slack `bot_profile` object attached to bot-authored messages
 * (subset relevant to sender classification).
 */
export interface SlackBotProfile {
  id?: string;
  name?: string;
  app_id?: string;
  team_id?: string;
}

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
  files?: SlackFile[];
  /** Team ID of the mentioning user's workspace. */
  team?: string;
  /** Present when the message was authored by a bot/app. */
  bot_id?: string;
  bot_profile?: SlackBotProfile;
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
  files?: SlackFile[];
  /** Present when the message was authored by a bot/app. */
  bot_id?: string;
  bot_profile?: SlackBotProfile;
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
  files?: SlackFile[];
  /** Team ID of the sending user's workspace. */
  team?: string;
  /** Present when the message was authored by a bot/app. */
  bot_id?: string;
  bot_profile?: SlackBotProfile;
}

/** `message.edited` / `previous_message.edited` sub-object. */
const slackEditedSchema = z
  .object({ user: optionalString(), ts: optionalString() })
  .optional()
  .catch(undefined);

/** `channel_type` is a known enum; an unrecognized value collapses to undefined. */
const slackMessageChannelType = () =>
  z.enum(["im", "channel", "group", "mpim"]).optional().catch(undefined);

/** The edited message body carried in a `message_changed` event's `message`. */
const slackChangedMessageSchema = z
  .object({
    user: optionalString(),
    text: optionalString(),
    ts: optionalString(),
    client_msg_id: optionalString(),
    thread_ts: optionalString(),
    edited: slackEditedSchema,
  })
  .optional()
  .catch(undefined);

/** The prior version carried in a `message_changed` event's `previous_message`. */
const slackChangedPreviousMessageSchema = z
  .object({
    user: optionalString(),
    text: optionalString(),
    ts: optionalString(),
    edited: slackEditedSchema,
  })
  .optional()
  .catch(undefined);

/**
 * Slack `message_changed` event — subtype `message_changed` wraps the edited
 * message in `event.message` and the prior version in `event.previous_message`.
 */
const slackMessageChangedEventSchema = z.object({
  type: optionalString(),
  subtype: optionalString(),
  channel: optionalString(),
  channel_type: slackMessageChannelType(),
  hidden: z.boolean().optional().catch(undefined),
  ts: optionalString(),
  event_ts: optionalString(),
  message: slackChangedMessageSchema,
  previous_message: slackChangedPreviousMessageSchema,
});
export type SlackMessageChangedEvent = z.infer<
  typeof slackMessageChangedEventSchema
>;

/** The prior content carried in a `message_deleted` event's `previous_message`. */
const slackDeletedPreviousMessageSchema = z
  .object({
    user: optionalString(),
    text: optionalString(),
    ts: optionalString(),
    thread_ts: optionalString(),
  })
  .optional()
  .catch(undefined);

/**
 * Slack `message_deleted` event — subtype `message_deleted` carries the
 * original message's `ts` in `event.deleted_ts` and the prior content in
 * `event.previous_message`.
 */
const slackMessageDeletedEventSchema = z.object({
  type: optionalString(),
  subtype: optionalString(),
  channel: optionalString(),
  channel_type: slackMessageChannelType(),
  hidden: z.boolean().optional().catch(undefined),
  ts: optionalString(),
  event_ts: optionalString(),
  deleted_ts: optionalString(),
  previous_message: slackDeletedPreviousMessageSchema,
});
export type SlackMessageDeletedEvent = z.infer<
  typeof slackMessageDeletedEventSchema
>;

// Compile-time cross-check against the official Slack event types, via the
// shared `webhook-crosscheck` helpers. The tolerant Zod schemas above stay the
// sole runtime validators; these type-only assertions make a field rename fail
// the build. Only key-integrity is asserted at the top level — the official
// `message` / `previous_message` are the broad `MessageEvent` union, so the
// inner edited-message shape is value-checked against the concrete
// `GenericMessageEvent` member instead.
type _SlackMessageApiCrossChecks = [
  Expect<
    ModeledKeysAreOfficial<
      z.infer<typeof slackMessageChangedEventSchema>,
      SlackApiMessageChangedEvent
    >
  >,
  Expect<
    ModeledKeysAreOfficial<
      z.infer<typeof slackMessageDeletedEventSchema>,
      SlackApiMessageDeletedEvent
    >
  >,
  Expect<
    ModeledKeysAreOfficial<
      NonNullable<z.infer<typeof slackChangedMessageSchema>>,
      SlackApiGenericMessageEvent
    >
  >,
  Expect<
    OfficialValueSatisfiesOurs<
      NonNullable<z.infer<typeof slackChangedMessageSchema>>,
      SlackApiGenericMessageEvent
    >
  >,
  Expect<
    ModeledKeysAreOfficial<
      NonNullable<z.infer<typeof slackDeletedPreviousMessageSchema>>,
      SlackApiGenericMessageEvent
    >
  >,
];

export type SlackTextRenderContext = {
  userLabels?: Record<string, string>;
  channelLabels?: Record<string, string>;
};

function renderSlackInboundText(
  text: string,
  context: SlackTextRenderContext = {},
): string {
  return renderSlackTextForModel(text, {
    userLabels: context.userLabels,
    channelLabels: context.channelLabels,
  });
}

export function slackUserActorFields(
  userInfo: SlackUserInfo,
): SlackUserActorFields {
  return {
    displayName: userInfo.displayName,
    username: userInfo.username,
    ...(userInfo.timezone !== undefined ? { timezone: userInfo.timezone } : {}),
    ...(userInfo.timezoneLabel !== undefined
      ? { timezoneLabel: userInfo.timezoneLabel }
      : {}),
    ...(userInfo.timezoneOffsetSeconds !== undefined
      ? { timezoneOffsetSeconds: userInfo.timezoneOffsetSeconds }
      : {}),
    ...(userInfo.isBot !== undefined ? { isBot: userInfo.isBot } : {}),
    ...(userInfo.isStranger !== undefined
      ? { isStranger: userInfo.isStranger }
      : {}),
    ...(userInfo.isRestricted !== undefined
      ? { isRestricted: userInfo.isRestricted }
      : {}),
  };
}

function extractSlackAttachments(files: SlackFile[] | undefined): Array<{
  type: "image" | "document";
  fileId: string;
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
}> {
  if (!files || files.length === 0) return [];
  return files
    .filter((f) => f.url_private_download || f.url_private)
    .map((f) => ({
      type: f.mimetype?.startsWith("image/")
        ? ("image" as const)
        : ("document" as const),
      fileId: f.id,
      fileName: f.name,
      mimeType: f.mimetype,
      fileSize: f.size,
    }));
}

function extractSlackFileMap(
  files: SlackFile[] | undefined,
): Map<string, SlackFile> | undefined {
  if (!files || files.length === 0) return undefined;
  const downloadableFiles = files.filter(
    (f) => f.url_private_download || f.url_private,
  );
  return downloadableFiles.length
    ? new Map(downloadableFiles.map((f) => [f.id, f]))
    : undefined;
}

/**
 * Descriptor for a bot/app sender, derived from the message's `bot_id` /
 * `bot_profile` and the resolved user profile's `is_bot` flag. Present on a
 * normalized event only when the sender is a bot.
 */
export interface SlackBotSenderInfo {
  botId?: string;
  botName?: string;
  appId?: string;
  teamId?: string;
}

/**
 * Classify a Slack message sender as a bot/app.
 *
 * Slack marks bot-authored messages with `bot_id` (and usually a
 * `bot_profile`); bot users are also flagged `is_bot` on `users.info`.
 * Returns undefined for human senders.
 */
export function slackBotSenderInfo(
  event: { bot_id?: string; bot_profile?: SlackBotProfile },
  userInfo?: SlackUserInfo,
): SlackBotSenderInfo | undefined {
  if (!event.bot_id && userInfo?.isBot !== true) return undefined;
  const botName = event.bot_profile?.name ?? userInfo?.displayName;
  return {
    ...(event.bot_id ? { botId: event.bot_id } : {}),
    ...(botName ? { botName } : {}),
    ...(event.bot_profile?.app_id ? { appId: event.bot_profile.app_id } : {}),
    ...(event.bot_profile?.team_id
      ? { teamId: event.bot_profile.team_id }
      : {}),
  };
}

/**
 * Human-readable contact note for a bot sender. Slack does not expose which
 * user owns/installed an app, so the note carries what Slack does provide:
 * the bot's name, Slack app ID, and workspace ID.
 */
export function slackBotContactNote(botSender: SlackBotSenderInfo): string {
  const details = [
    ...(botSender.appId ? [`Slack app ${botSender.appId}`] : []),
    ...(botSender.teamId ? [`workspace ${botSender.teamId}`] : []),
  ];
  const name = botSender.botName ? ` "${botSender.botName}"` : "";
  const suffix = details.length > 0 ? ` (${details.join(", ")})` : "";
  return `Automated Slack bot${name}${suffix} — messages from this contact are sent by an app, not a person.`;
}

export type NormalizedSlackEvent = {
  event: GatewayInboundEvent;
  routing: RouteResult;
  /** Thread timestamp for reply threading. */
  threadTs?: string;
  /** Slack channel ID. */
  channel: string;
  /** Original Slack file objects keyed by file ID, for download in the I/O layer. */
  slackFiles?: Map<string, SlackFile>;
  /** Present when the sender is a bot/app rather than a person. */
  botSender?: SlackBotSenderInfo;
};

/**
 * Merge a freshly resolved user profile into an already-normalized event.
 *
 * Normalization uses a cache-only user lookup, so a cold cache can leave the
 * actor unenriched. Besides display/trust fields, this re-runs bot-sender
 * classification against the original event: a bot user whose message carries
 * no top-level `bot_id` is only detectable via the profile's `is_bot`, which
 * is unavailable until this fetch completes.
 */
export function enrichNormalizedActor(
  normalized: NormalizedSlackEvent,
  userInfo: SlackUserInfo,
): void {
  const actor = normalized.event.actor;
  Object.assign(actor, slackUserActorFields(userInfo));
  if (!normalized.botSender) {
    const botSender = slackBotSenderInfo(
      normalized.event.raw as {
        bot_id?: string;
        bot_profile?: SlackBotProfile;
      },
      userInfo,
    );
    if (botSender) {
      normalized.botSender = botSender;
      actor.isBot = true;
    }
  }
}

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
export function normalizeSlackDirectMessage(
  event: SlackDirectMessageEvent,
  eventId: string,
  config: GatewayConfig,
  botToken?: string,
  renderContext?: SlackTextRenderContext,
): NormalizedSlackEvent | null {
  // Ignore message subtypes (edits, deletions, etc.) — only handle plain user messages.
  // message_changed is handled separately by normalizeSlackMessageEdit.
  // file_share is allowed so image/file uploads are delivered to the assistant.
  if (event.subtype && event.subtype !== "file_share") return null;
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

  const attachments = extractSlackAttachments(event.files);
  const slackFiles = extractSlackFileMap(event.files);

  // Use cache-only lookup to avoid blocking normalization on network calls.
  // A background fetch warms the cache for subsequent messages from this user.
  const userInfo =
    botToken && event.user
      ? resolveSlackUserSync(event.user, botToken)
      : undefined;
  const botSender = slackBotSenderInfo(event, userInfo);
  const content = renderSlackInboundText(event.text, renderContext);

  return {
    event: {
      version: "v1",
      sourceChannel: "slack",
      receivedAt: new Date().toISOString(),
      message: {
        content,
        conversationExternalId: event.channel,
        externalMessageId,
        ...(attachments.length > 0 ? { attachments } : {}),
      },
      actor: {
        actorExternalId: event.user,
        ...(userInfo ? slackUserActorFields(userInfo) : {}),
        ...(botSender ? { isBot: true } : {}),
      },
      source: {
        updateId: eventId,
        messageId: event.ts,
        chatType: "im",
        ...(event.thread_ts ? { threadId: event.thread_ts } : {}),
      },
      raw: event as unknown as Record<string, unknown>,
    },
    routing,
    ...(event.thread_ts ? { threadTs: event.thread_ts } : {}),
    channel: event.channel,
    ...(slackFiles ? { slackFiles } : {}),
    ...(botSender ? { botSender } : {}),
  };
}

/**
 * Normalize a Slack channel `message` event (thread reply in an active bot
 * thread) into the gateway's canonical inbound event shape.
 *
 * Returns null if the event should be ignored (subtypes, missing user,
 * or unroutable channels).
 *
 * Bot's own messages are dropped by `processEventPayload` before
 * normalization.
 */
export function normalizeSlackChannelMessage(
  event: SlackChannelMessageEvent,
  eventId: string,
  config: GatewayConfig,
  botToken?: string,
  renderContext?: SlackTextRenderContext,
): NormalizedSlackEvent | null {
  // file_share is allowed so image/file uploads are delivered to the assistant.
  if (event.subtype && event.subtype !== "file_share") return null;
  if (!event.user) return null;

  const routing = resolveAssistant(config, event.channel, event.user);
  if (isRejection(routing)) return null;

  const content = renderSlackInboundText(event.text, renderContext);
  const externalMessageId =
    event.client_msg_id ?? event.ts ?? `${event.channel}:${event.ts}`;

  const attachments = extractSlackAttachments(event.files);
  const slackFiles = extractSlackFileMap(event.files);

  const userInfo =
    botToken && event.user
      ? resolveSlackUserSync(event.user, botToken)
      : undefined;
  const botSender = slackBotSenderInfo(event, userInfo);

  return {
    event: {
      version: "v1",
      sourceChannel: "slack",
      receivedAt: new Date().toISOString(),
      message: {
        content,
        conversationExternalId: event.channel,
        externalMessageId,
        ...(attachments.length > 0 ? { attachments } : {}),
      },
      actor: {
        actorExternalId: event.user,
        ...(userInfo ? slackUserActorFields(userInfo) : {}),
        ...(event.team ? { teamId: event.team } : {}),
        ...(botSender ? { isBot: true } : {}),
      },
      source: {
        updateId: eventId,
        messageId: event.ts,
        chatType: "channel",
        ...(event.thread_ts ? { threadId: event.thread_ts } : {}),
      },
      raw: event as unknown as Record<string, unknown>,
    },
    routing,
    threadTs: event.thread_ts ?? event.ts,
    channel: event.channel,
    ...(slackFiles ? { slackFiles } : {}),
    ...(botSender ? { botSender } : {}),
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
  botToken?: string,
  renderContext?: SlackTextRenderContext,
): NormalizedSlackEvent | null {
  const routing = resolveAssistant(config, event.channel, event.user);
  if (isRejection(routing)) {
    return null;
  }

  const content = renderSlackInboundText(event.text, renderContext);
  const externalMessageId =
    event.client_msg_id ?? event.ts ?? `${event.channel}:${event.ts}`;

  const attachments = extractSlackAttachments(event.files);
  const slackFiles = extractSlackFileMap(event.files);

  const userInfo =
    botToken && event.user
      ? resolveSlackUserSync(event.user, botToken)
      : undefined;
  const botSender = slackBotSenderInfo(event, userInfo);

  return {
    event: {
      version: "v1",
      sourceChannel: "slack",
      receivedAt: new Date().toISOString(),
      message: {
        content,
        conversationExternalId: event.channel,
        externalMessageId,
        ...(attachments.length > 0 ? { attachments } : {}),
      },
      actor: {
        actorExternalId: event.user,
        ...(userInfo ? slackUserActorFields(userInfo) : {}),
        ...(event.team ? { teamId: event.team } : {}),
        ...(botSender ? { isBot: true } : {}),
      },
      source: {
        updateId: eventId,
        messageId: event.ts,
        ...(event.thread_ts ? { threadId: event.thread_ts } : {}),
      },
      raw: event as unknown as Record<string, unknown>,
    },
    routing,
    threadTs: event.thread_ts ?? event.ts,
    channel: event.channel,
    ...(slackFiles ? { slackFiles } : {}),
    ...(botSender ? { botSender } : {}),
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
  message?: { ts: string; thread_ts?: string; text?: string };
  actions: Array<{
    action_id: string;
    value?: string;
    type: string;
    block_id?: string;
    action_ts?: string;
  }>;
}

/**
 * Slack `reaction_added` / `reaction_removed` event. Both carry an identical
 * payload, differentiated only by the `type` discriminator (the caller passes
 * the add-vs-remove distinction as an explicit `op`).
 */
const slackReactionEventSchema = z.object({
  type: optionalString(),
  user: optionalString(),
  reaction: optionalString(),
  item: z
    .object({
      type: optionalString(),
      channel: optionalString(),
      ts: optionalString(),
    })
    .optional()
    .catch(undefined),
  item_user: optionalString(),
  event_ts: optionalString(),
});
type SlackReactionEvent = z.infer<typeof slackReactionEventSchema>;

/** Kept for `socket-mode.ts`'s narrowing casts; both are one payload shape. */
export type SlackReactionAddedEvent = SlackReactionEvent;
export type SlackReactionRemovedEvent = SlackReactionEvent;

// Compile-time cross-check against the official Slack event types, via the
// shared `webhook-crosscheck` helpers. `@slack/types` is a types-only
// dependency: the `import type` above is erased from the build, so
// `slackReactionEventSchema` stays the sole runtime validator. `tsc` proves our
// tolerant schema never contradicts Slack's published shape, so a field rename
// or wrong primitive fails the build instead of silently parsing a live event
// to `undefined`.
type _SlackReactionApiCrossChecks = [
  Expect<
    ModeledKeysAreOfficial<SlackReactionEvent, SlackApiReactionAddedEvent>
  >,
  Expect<
    OfficialValueSatisfiesOurs<SlackReactionEvent, SlackApiReactionAddedEvent>
  >,
  Expect<
    ModeledKeysAreOfficial<SlackReactionEvent, SlackApiReactionRemovedEvent>
  >,
  Expect<
    OfficialValueSatisfiesOurs<SlackReactionEvent, SlackApiReactionRemovedEvent>
  >,
];

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
        ...(payload.message?.thread_ts
          ? { threadId: payload.message.thread_ts }
          : {}),
      },
      raw: payload as unknown as Record<string, unknown>,
    },
    routing,
    // Prefer the thread root so follow-up messages land in the original
    // conversation thread, not a reply's sub-thread.
    threadTs: payload.message?.thread_ts ?? messageTs ?? envelopeId,
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
