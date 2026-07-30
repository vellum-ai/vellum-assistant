import { createHash } from "node:crypto";
import { fetchImpl } from "../fetch.js";

// Slack user/channel directory: resolves display names and channel names via
// the Slack Web API (users.info / conversations.info), with an in-memory LRU
// cache and in-flight de-duplication so a burst of events triggers one call
// per id. These reads hit Slack's authenticated API, not untrusted ingress.

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
