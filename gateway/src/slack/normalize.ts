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
}

interface CacheEntry {
  value: SlackUserInfo;
  expiresAt: number;
}

const USER_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const USER_CACHE_MAX_SIZE = 500;

/**
 * In-memory LRU cache for Slack user info lookups.
 * Entries expire after TTL and the cache evicts least-recently-used
 * entries when it exceeds MAX_SIZE.
 */
const userInfoCache = new Map<string, CacheEntry>();

function evictExpired(): void {
  const now = Date.now();
  for (const [key, entry] of userInfoCache) {
    if (entry.expiresAt <= now) {
      userInfoCache.delete(key);
    }
  }
}

function cacheGet(userId: string): SlackUserInfo | undefined {
  const entry = userInfoCache.get(userId);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    userInfoCache.delete(userId);
    return undefined;
  }
  // Move to end for LRU ordering (Map preserves insertion order)
  userInfoCache.delete(userId);
  userInfoCache.set(userId, entry);
  return entry.value;
}

function cacheSet(userId: string, value: SlackUserInfo): void {
  // Evict if over capacity
  if (userInfoCache.size >= USER_CACHE_MAX_SIZE) {
    evictExpired();
    // If still over capacity, evict oldest entry
    if (userInfoCache.size >= USER_CACHE_MAX_SIZE) {
      const oldest = userInfoCache.keys().next().value;
      if (oldest) userInfoCache.delete(oldest);
    }
  }
  userInfoCache.set(userId, {
    value,
    expiresAt: Date.now() + USER_CACHE_TTL_MS,
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
  const cached = cacheGet(userId);
  if (cached) return cached;

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

    const info: SlackUserInfo = { displayName, username };
    cacheSet(userId, info);
    return info;
  } catch {
    return undefined;
  }
}

/** Exported for testing — clears the user info cache. */
export function clearUserInfoCache(): void {
  userInfoCache.clear();
}

/** Exported for testing — returns current cache size. */
export function getUserInfoCacheSize(): number {
  return userInfoCache.size;
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
export async function normalizeSlackDirectMessage(
  event: SlackDirectMessageEvent,
  eventId: string,
  config: GatewayConfig,
  botUserId?: string,
): Promise<NormalizedSlackEvent | null> {
  // Ignore messages from the bot itself
  if (botUserId && event.user === botUserId) return null;
  // Ignore message subtypes (edits, deletions, etc.) — only handle plain user messages
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

  // Resolve display name if bot token is available
  const userInfo =
    config.slackChannelBotToken && event.user
      ? await resolveSlackUser(event.user, config.slackChannelBotToken)
      : undefined;

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
        ...(userInfo && {
          displayName: userInfo.displayName,
          username: userInfo.username,
        }),
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
export async function normalizeSlackChannelMessage(
  event: SlackChannelMessageEvent,
  eventId: string,
  config: GatewayConfig,
  botUserId?: string,
): Promise<NormalizedSlackEvent | null> {
  if (botUserId && event.user === botUserId) return null;
  if (event.subtype) return null;
  if (!event.user) return null;

  const routing = resolveAssistant(config, event.channel, event.user);
  if (isRejection(routing)) return null;

  const content = stripBotMention(event.text);
  const externalMessageId =
    event.client_msg_id ?? event.ts ?? `${event.channel}:${event.ts}`;

  // Resolve display name if bot token is available
  const userInfo =
    config.slackChannelBotToken && event.user
      ? await resolveSlackUser(event.user, config.slackChannelBotToken)
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
      },
      actor: {
        actorExternalId: event.user,
        ...(userInfo && {
          displayName: userInfo.displayName,
          username: userInfo.username,
        }),
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
export async function normalizeSlackAppMention(
  event: SlackAppMentionEvent,
  eventId: string,
  config: GatewayConfig,
): Promise<NormalizedSlackEvent | null> {
  const routing = resolveAssistant(config, event.channel, event.user);
  if (isRejection(routing)) {
    return null;
  }

  const content = stripBotMention(event.text);
  const externalMessageId =
    event.client_msg_id ?? event.ts ?? `${event.channel}:${event.ts}`;

  // Resolve display name if bot token is available
  const userInfo =
    config.slackChannelBotToken && event.user
      ? await resolveSlackUser(event.user, config.slackChannelBotToken)
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
      },
      actor: {
        actorExternalId: event.user,
        ...(userInfo && {
          displayName: userInfo.displayName,
          username: userInfo.username,
        }),
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
