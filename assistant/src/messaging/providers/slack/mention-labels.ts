/**
 * Cached resolution of inline Slack mention labels (`<@U…>` user names,
 * `<#C…>` channel names) for text rendering.
 *
 * Shared by the messaging adapter (live Slack API reads: history, search,
 * thread replies) and the persisted-history projection surfaces (chronological
 * model transcript, messages GET), so every renderer resolves names through
 * one cache with one refresh policy.
 *
 * Entries are auth-scoped and expire after {@link LABEL_CACHE_TTL_MS} so a
 * renamed channel or user heals within the TTL instead of pinning the name
 * first observed in this process. Lookups de-duplicate via in-flight promises;
 * transient failures are evicted immediately so the next batch retries, while
 * definitive failures (not found / no permission) stay cached for the TTL so
 * a wall of history mentioning an inaccessible channel doesn't re-fire a
 * doomed lookup per render.
 */

import { createHash } from "node:crypto";

import {
  buildSlackChannelLabelMap,
  buildSlackUserLabelMap,
} from "@vellumai/slack-text";

import { findContactChannel } from "../../../contacts/contact-store.js";
import { getLogger } from "../../../util/logger.js";
import { resolveSlackAuth, type SlackAuth } from "./auth.js";
import * as slack from "./client.js";
import { slackUserDisplayName } from "./conversation-utils.js";
import type { SlackUser } from "./types.js";
import { SlackApiError } from "./web-api-transport.js";

const log = getLogger("slack-mention-labels");

export interface NormalizedSlackUserInfo {
  displayName: string;
  timezone?: string;
  timezoneLabel?: string;
  timezoneOffsetSeconds?: number;
}

interface SlackUserInfoLookupResult {
  info: NormalizedSlackUserInfo;
  cacheable: boolean;
}

export interface SlackMentionLabels {
  userLabels: Record<string, string>;
  channelLabels: Record<string, string>;
}

const PERMANENT_USER_INFO_SLACK_ERRORS = new Set([
  "account_inactive",
  "ekm_access_denied",
  "missing_scope",
  "not_allowed_token_type",
  "user_not_found",
  "user_not_visible",
]);

/** How long a resolved (or definitively unresolvable) label stays cached. */
const LABEL_CACHE_TTL_MS = 15 * 60 * 1000;

/** Cap per cache; oldest entries evict first once full. */
const LABEL_CACHE_MAX_SIZE = 500;

/**
 * Overall bound on a projection label-resolution pass. Projection callers sit
 * on latency-sensitive paths (turn assembly, messages GET); a Slack outage
 * must degrade to fallback labels, not stall the turn.
 */
const DEFAULT_PROJECTION_TIMEOUT_MS = 3_000;

interface CacheEntry<T> {
  promise: Promise<T>;
  expiresAt: number;
}

// Values are stored as in-flight promises so concurrent lookups de-dupe.
const userInfoCache = new Map<string, CacheEntry<SlackUserInfoLookupResult>>();
const channelNameCache = new Map<string, CacheEntry<string | undefined>>();

function cacheGet<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
): Promise<T> | undefined {
  const entry = cache.get(key);
  if (!entry) {
    return undefined;
  }
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return entry.promise;
}

function cacheSet<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  promise: Promise<T>,
): void {
  if (cache.size >= LABEL_CACHE_MAX_SIZE && !cache.has(key)) {
    for (const existingKey of cache.keys()) {
      const entry = cache.get(existingKey);
      if (entry && entry.expiresAt <= Date.now()) {
        cache.delete(existingKey);
      }
      if (cache.size < LABEL_CACHE_MAX_SIZE) {
        break;
      }
    }
    if (cache.size >= LABEL_CACHE_MAX_SIZE) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) {
        cache.delete(oldest);
      }
    }
  }
  cache.set(key, { promise, expiresAt: Date.now() + LABEL_CACHE_TTL_MS });
}

export function slackAuthCacheScope(auth: SlackAuth): string {
  return typeof auth === "string"
    ? `token:${createHash("sha256").update(auth).digest("hex")}`
    : `connection:${auth.id}:${auth.accountInfo ?? ""}`;
}

function slackUserInfoCacheKey(auth: SlackAuth, userId: string): string {
  return `${slackAuthCacheScope(auth)}:user:${userId}`;
}

export async function resolveUserName(
  auth: SlackAuth,
  userId: string,
): Promise<string> {
  return (await resolveUserInfo(auth, userId)).displayName;
}

export async function resolveUserInfo(
  auth: SlackAuth,
  userId: string,
): Promise<NormalizedSlackUserInfo> {
  if (!userId) {
    return { displayName: "unknown" };
  }
  const cacheKey = slackUserInfoCacheKey(auth, userId);
  const cached = cacheGet(userInfoCache, cacheKey);
  if (cached) {
    return (await cached).info;
  }

  const resolved = resolveUserInfoUncached(auth, userId).then(
    (result) => {
      if (!result.cacheable) {
        userInfoCache.delete(cacheKey);
      }
      return result;
    },
    (err) => {
      userInfoCache.delete(cacheKey);
      throw err;
    },
  );
  cacheSet(userInfoCache, cacheKey, resolved);
  return (await resolved).info;
}

async function resolveUserInfoUncached(
  auth: SlackAuth,
  userId: string,
): Promise<SlackUserInfoLookupResult> {
  let contactDisplayName: string | undefined;
  try {
    const result = findContactChannel({
      channelType: "slack",
      address: userId,
    });
    if (result) {
      contactDisplayName = result.contact.displayName;
    }
  } catch {
    // Contact lookup failures are non-fatal; fall through to the API.
  }

  try {
    const resp = await slack.userInfo(auth, userId);
    return {
      info: normalizeSlackUserInfo(resp.user, contactDisplayName),
      cacheable: true,
    };
  } catch (err) {
    return {
      info: { displayName: contactDisplayName ?? userId },
      cacheable: isPermanentSlackUserInfoFailure(err),
    };
  }
}

function isPermanentSlackUserInfoFailure(err: unknown): boolean {
  return (
    err instanceof SlackApiError &&
    PERMANENT_USER_INFO_SLACK_ERRORS.has(err.slackError)
  );
}

/**
 * Resolve a channel's display name for inline mention rendering, cached per
 * auth scope. Returns undefined when the channel has no name (DMs) or this
 * auth cannot see it; transient failures are not cached so a later batch
 * retries.
 */
export async function resolveChannelName(
  auth: SlackAuth,
  channelId: string,
): Promise<string | undefined> {
  if (!channelId) {
    return undefined;
  }
  const cacheKey = `${slackAuthCacheScope(auth)}:channel:${channelId}`;
  const cached = cacheGet(channelNameCache, cacheKey);
  if (cached) {
    return cached;
  }

  const resolved = slack.conversationInfo(auth, channelId).then(
    (resp) => trimNonEmptyLabel(resp.channel.name),
    (err: unknown) => {
      // Cache the definitive "this auth cannot resolve it" answers; drop
      // everything else so transient failures retry on the next batch.
      const permanent =
        err instanceof SlackApiError &&
        (err.category === "channel_not_found" || err.category === "permission");
      if (!permanent) {
        channelNameCache.delete(cacheKey);
      }
      return undefined;
    },
  );
  cacheSet(channelNameCache, cacheKey, resolved);
  return resolved;
}

export function normalizeSlackUserInfo(
  user: SlackUser,
  contactDisplayName: string | undefined,
): NormalizedSlackUserInfo {
  const displayName =
    contactDisplayName || slackUserDisplayName(user) || user.id;
  const timezone = trimNonEmptyLabel(user.tz);
  const timezoneLabel = trimNonEmptyLabel(user.tz_label);
  const timezoneOffsetSeconds =
    typeof user.tz_offset === "number" && Number.isFinite(user.tz_offset)
      ? user.tz_offset
      : undefined;
  return {
    displayName,
    ...(timezone ? { timezone } : {}),
    ...(timezoneLabel ? { timezoneLabel } : {}),
    ...(timezoneOffsetSeconds !== undefined ? { timezoneOffsetSeconds } : {}),
  };
}

function trimNonEmptyLabel(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Resolve display labels for every user and channel mentioned inline in the
 * given texts, so bare `<@U…>` / `<#C…>` tokens render as names instead of
 * falling back to `@unknown-user (U…)` / `#unknown-channel (C…)`. Pipe-form
 * tokens carry their own label and are skipped by the map builders.
 */
export async function buildMentionLabels(
  auth: SlackAuth,
  textValues: readonly (string | undefined)[],
): Promise<SlackMentionLabels> {
  const [userLabels, channelLabels] = await Promise.all([
    buildSlackUserLabelMap(textValues, (userId) =>
      resolveUserName(auth, userId),
    ),
    buildSlackChannelLabelMap(textValues, (channelId) =>
      resolveChannelName(auth, channelId),
    ),
  ]);
  return { userLabels, channelLabels };
}

/**
 * Projection-surface entry point: resolve mention labels for persisted Slack
 * texts, bounded by a timeout so a slow or unreachable Slack API degrades to
 * fallback labels instead of stalling the caller (turn assembly, messages
 * GET). Resolves its own auth; the user identity is preferred because it can
 * see channels the bot is not in, and `resolveSlackAuth("user")` falls back
 * to the bot token when no user token is stored.
 *
 * Returns `{}`-shaped empty labels when Slack auth is unavailable or the
 * timeout elapses; the label caches keep whatever resolutions completed, so
 * the next projection pass picks them up.
 */
export async function resolveSlackMentionLabelsForTexts(
  textValues: readonly (string | undefined)[],
  options: { timeoutMs?: number; account?: string } = {},
): Promise<SlackMentionLabels> {
  const empty: SlackMentionLabels = { userLabels: {}, channelLabels: {} };
  if (!textValues.some((text) => text)) {
    return empty;
  }
  try {
    const auth = await resolveSlackAuth("user", {
      ...(options.account ? { account: options.account } : {}),
    });
    if (!auth) {
      return empty;
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_PROJECTION_TIMEOUT_MS;
    const labels = await Promise.race([
      buildMentionLabels(auth, textValues),
      new Promise<undefined>((resolve) => {
        setTimeout(resolve, timeoutMs);
      }),
    ]);
    return labels ?? empty;
  } catch (err) {
    log.debug({ err }, "Slack mention label resolution failed");
    return empty;
  }
}

export function __resetSlackMentionCachesForTests(): void {
  userInfoCache.clear();
  channelNameCache.clear();
}
