import { renderSlackTextForModel } from "@vellumai/slack-text";
import { createHash } from "node:crypto";
import { isSlackDmChannel } from "./channel.js";
import type { GatewayConfig } from "../config.js";
import { fetchImpl } from "../fetch.js";
import { resolveAssistant, isRejection } from "../routing/resolve-assistant.js";
import type { RouteResult } from "../routing/types.js";
import type { GatewayInboundEvent } from "../types.js";

/**
 * Resolved Slack user info for populating actor fields.
 */
interface SlackUserInfo {
  displayName: string;
  username: string;
  timezone?: string;
  timezoneLabel?: string;
  timezoneOffsetSeconds?: number;
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

      const isStranger = data.user.is_stranger === true ? true : undefined;
      const isRestricted =
        data.user.is_restricted === true ||
        data.user.is_ultra_restricted === true
          ? true
          : undefined;

      const info: SlackUserInfo = {
        displayName,
        username,
        ...(timezone !== undefined ? { timezone } : {}),
        ...(timezoneLabel !== undefined ? { timezoneLabel } : {}),
        ...(timezoneOffsetSeconds !== undefined
          ? { timezoneOffsetSeconds }
          : {}),
        ...(isStranger !== undefined ? { isStranger } : {}),
        ...(isRestricted !== undefined ? { isRestricted } : {}),
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
    edited?: { user: string; ts: string };
  };
  previous_message?: {
    user?: string;
    text: string;
    ts: string;
    edited?: { user: string; ts: string };
  };
}

/**
 * Slack `message_deleted` event shape — subtype `message_deleted` carries
 * the original message's `ts` in `event.deleted_ts` and the prior content
 * in `event.previous_message`.
 */
export interface SlackMessageDeletedEvent {
  type: "message";
  subtype: "message_deleted";
  channel: string;
  channel_type?: "im" | "channel" | "group" | "mpim";
  hidden?: boolean;
  ts: string;
  event_ts?: string;
  deleted_ts: string;
  previous_message?: {
    user?: string;
    text: string;
    ts: string;
    thread_ts?: string;
  };
}

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

export type NormalizedSlackEvent = {
  event: GatewayInboundEvent;
  routing: RouteResult;
  /** Thread timestamp for reply threading. */
  threadTs?: string;
  /** Slack channel ID. */
  channel: string;
  /** Original Slack file objects keyed by file ID, for download in the I/O layer. */
  slackFiles?: Map<string, SlackFile>;
};

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
 * Slack `reaction_removed` event shape — same payload as `reaction_added`,
 * differentiated only by the `type` discriminator.
 */
export interface SlackReactionRemovedEvent {
  type: "reaction_removed";
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
  event: SlackReactionAddedEvent | SlackReactionRemovedEvent,
  eventId: string,
  config: GatewayConfig,
  op: "added" | "removed",
): NormalizedSlackEvent | null {
  if (!event.user || !event.item?.channel || !event.item?.ts) return null;

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
      raw: event as unknown as Record<string, unknown>,
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
  event: SlackReactionAddedEvent,
  eventId: string,
  config: GatewayConfig,
): NormalizedSlackEvent | null {
  return normalizeSlackReaction(event, eventId, config, "added");
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
  event: SlackReactionRemovedEvent,
  eventId: string,
  config: GatewayConfig,
): NormalizedSlackEvent | null {
  return normalizeSlackReaction(event, eventId, config, "removed");
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
  event: SlackMessageChangedEvent,
  eventId: string,
  config: GatewayConfig,
  renderContext?: SlackTextRenderContext,
): NormalizedSlackEvent | null {
  const edited = event.message;
  if (!edited) return null;

  const editTimestampUnchanged =
    event.previous_message !== undefined &&
    event.previous_message.edited?.ts === edited.edited?.ts;
  if (editTimestampUnchanged) return null;

  // user is required for routing
  if (!edited.user) return null;

  // Try channel routing, fall back to default for DMs so edits in DMs still
  // take the defaultAssistantId routing branch.
  const isDm = isSlackDmChannel(event.channel, event.channel_type);
  let routing = resolveAssistant(config, event.channel, edited.user);
  if (isRejection(routing) && isDm && config.defaultAssistantId) {
    routing = {
      assistantId: config.defaultAssistantId,
      routeSource: "default" as const,
    };
  }
  if (isRejection(routing)) return null;

  const content = renderSlackInboundText(edited.text, renderContext);

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
        ...(edited.thread_ts ? { threadId: edited.thread_ts } : {}),
      },
      raw: event as unknown as Record<string, unknown>,
    },
    routing,
    // For DMs without a thread, omit threadTs so the reply goes directly in conversation.
    // For channels (or DMs already in a thread), fall back to edited.ts.
    ...(isDm && !edited.thread_ts
      ? {}
      : { threadTs: edited.thread_ts ?? edited.ts }),
    channel: event.channel,
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
  event: SlackMessageDeletedEvent,
  eventId: string,
  config: GatewayConfig,
): NormalizedSlackEvent | null {
  if (!event.deleted_ts) return null;

  // Use the previous author for actor identity when available; otherwise fall
  // back to a synthetic identifier so routing/trust still has something to key on.
  const actorId = event.previous_message?.user ?? "slack-system";

  // Fall back to the default assistant for DMs so deletes from DMs still take
  // the defaultAssistantId routing branch.
  const isDm = isSlackDmChannel(event.channel, event.channel_type);
  let routing = resolveAssistant(config, event.channel, actorId);
  if (isRejection(routing) && isDm && config.defaultAssistantId) {
    routing = {
      assistantId: config.defaultAssistantId,
      routeSource: "default" as const,
    };
  }
  if (isRejection(routing)) return null;

  const previousThreadTs = event.previous_message?.thread_ts;

  return {
    event: {
      version: "v1",
      sourceChannel: "slack",
      receivedAt: new Date().toISOString(),
      message: {
        content: "",
        conversationExternalId: event.channel,
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
        messageId: event.deleted_ts,
        ...(isDm ? {} : { chatType: "channel" }),
        ...(previousThreadTs ? { threadId: previousThreadTs } : {}),
      },
      raw: event as unknown as Record<string, unknown>,
    },
    routing,
    // Preserve thread context so downstream handling stays scoped to the
    // original conversation thread when applicable.
    ...(previousThreadTs ? { threadTs: previousThreadTs } : {}),
    channel: event.channel,
  };
}
