/**
 * Slack messaging provider adapter.
 *
 * Maps Slack API responses to the platform-agnostic messaging types and
 * implements the MessagingProvider interface.
 */

import { createHash } from "node:crypto";

import {
  buildSlackUserLabelMap,
  renderSlackTextForModel,
} from "@vellumai/slack-text";

import { findContactChannel } from "../../../contacts/contact-store.js";
import type { OAuthConnection } from "../../../oauth/connection.js";
import { resolveOAuthConnection } from "../../../oauth/connection-resolver.js";
import { isProviderConnected } from "../../../oauth/oauth-store.js";
import { credentialKey } from "../../../security/credential-key.js";
import { getSecureKeyAsync } from "../../../security/secure-keys.js";
import type { MessagingProvider } from "../../provider.js";
import type {
  ConnectionInfo,
  Conversation,
  HistoryOptions,
  HistoryPageResult,
  ListOptions,
  Message,
  SearchOptions,
  SearchResult,
  SendOptions,
  SendResult,
} from "../../provider-types.js";
import * as slack from "./client.js";
import { SlackApiError } from "./client.js";
import type {
  SlackConversation,
  SlackMessage,
  SlackSearchMatch,
  SlackUser,
} from "./types.js";

interface NormalizedSlackUserInfo {
  displayName: string;
  timezone?: string;
  timezoneLabel?: string;
  timezoneOffsetSeconds?: number;
}

interface SlackUserInfoLookupResult {
  info: NormalizedSlackUserInfo;
  cacheable: boolean;
}

const PERMANENT_USER_INFO_SLACK_ERRORS = new Set([
  "account_inactive",
  "ekm_access_denied",
  "missing_scope",
  "not_allowed_token_type",
  "user_not_found",
  "user_not_visible",
]);

// Cache normalized Slack user facts to avoid repeated API calls within a session.
const userInfoCache = new Map<string, Promise<SlackUserInfoLookupResult>>();

/**
 * Cached auth resolved during resolveConnection(), split by direction.
 *
 * Read and write auth are tracked separately so reads can use a user OAuth
 * token (xoxp-) — giving visibility into channels the user is in but the
 * bot isn't — while writes continue to use the bot token (xoxb-) so posts
 * come from the bot identity. When no user_token is stored, reads fall
 * back to the bot token. If a stored user_token is rejected at runtime
 * (revoked/expired), the read cache is reset to the bot token for the rest
 * of the session — see runReadWithFallback().
 *
 * For Socket Mode these hold a raw bot token string; for OAuth they hold the
 * OAuthConnection. The Slack client functions accept both via their own
 * OAuthConnection | string union, so we can pass the cached value through
 * directly.
 */
let _cachedSlackWriteAuth: OAuthConnection | string | null = null;
let _cachedSlackReadAuth: OAuthConnection | string | null = null;
const botUserIdByBotIdCache = new Map<string, string>();

/**
 * Get the Slack auth value to pass to Slack client functions.
 * Prefers the explicit connection from the caller; falls back to the cached
 * write auth. Callers that care about read vs write semantics should use
 * getReadAuth() / getWriteAuth() directly.
 */
function getSlackAuth(connection?: OAuthConnection): OAuthConnection | string {
  if (connection) return connection;
  if (_cachedSlackWriteAuth) return _cachedSlackWriteAuth;
  if (_cachedSlackReadAuth) return _cachedSlackReadAuth;
  throw new Error(
    "Slack: no connection or cached token available. Was resolveConnection() called?",
  );
}

/**
 * Resolve auth for read operations (listConversations, getHistory,
 * conversation replies, search, users.info lookups).
 */
function getReadAuth(connection?: OAuthConnection): OAuthConnection | string {
  if (connection) return connection;
  if (_cachedSlackReadAuth) return _cachedSlackReadAuth;
  return getSlackAuth(connection);
}

// SAFETY: content-creating writes (postMessage, updateMessage, deleteMessage,
// reactions) MUST use the bot token. Using the user token would post as the
// user, not as the bot. State-changing methods that target the authenticated
// identity's own state (e.g. conversations.mark) should use the read auth so
// the cursor matches the perspective the adapter exposes.
/**
 * Resolve auth for content-creating write operations (postMessage and any
 * future reactions, joins, leaves, updates, or deletes).
 */
function getWriteAuth(connection?: OAuthConnection): OAuthConnection | string {
  if (connection) return connection;
  if (_cachedSlackWriteAuth) return _cachedSlackWriteAuth;
  return getSlackAuth(connection);
}

/**
 * Resolve the bot token (raw string) and pass it to `fn`. Returns the
 * callback's result, or `null` when no Slack auth is available.
 *
 * Bridges the Socket Mode case (cached string token) and the OAuth case
 * (`OAuthConnection.withToken`) for callers that need a raw token to hand
 * to a non-Slack-client API call — currently `downloadSlackFile` for inline
 * file/image fetches. Slack-client method calls should keep going through
 * `getReadAuth` / `getWriteAuth` and pass the union through.
 */
export async function withSlackBotToken<T>(
  account: string | undefined,
  fn: (token: string) => Promise<T>,
): Promise<T | null> {
  // Resolve for this call's account even when the process cache is warm.
  // Multi-workspace backfills can interleave, so use the returned connection
  // directly instead of accepting any previously cached workspace token.
  const resolvedAuth = await slackProvider.resolveConnection?.(account);
  const auth = resolvedAuth ?? _cachedSlackWriteAuth;
  if (!auth) return null;
  if (typeof auth === "string") return fn(auth);
  return auth.withToken(fn);
}

export async function resolveSlackBotUserId(
  account: string | undefined,
  botId: string,
): Promise<string | null> {
  const trimmedBotId = botId.trim();
  if (!trimmedBotId) return null;

  const cacheKey = account ? `${account}:${trimmedBotId}` : null;
  if (cacheKey && botUserIdByBotIdCache.has(cacheKey)) {
    return botUserIdByBotIdCache.get(cacheKey) ?? null;
  }

  const resolvedUserId = await withSlackBotToken(account, async (token) => {
    const resp = await slack.botsInfo(token, trimmedBotId);
    const userId = resp.bot.user_id?.trim();
    return userId && userId.length > 0 ? userId : null;
  });
  if (resolvedUserId) {
    if (cacheKey) {
      botUserIdByBotIdCache.set(cacheKey, resolvedUserId);
    }
    return resolvedUserId;
  }
  return null;
}

/**
 * Run a read-path Slack call, falling back to the bot token if the cached
 * user token is rejected with an auth error. On fallback, the read cache is
 * reset to the bot token so subsequent reads in this session don't re-pay
 * the round trip. Caller-supplied connections are passed through unchanged
 * (no fallback) since the caller owns that auth.
 */
async function runReadWithFallback<T>(
  connection: OAuthConnection | undefined,
  call: (auth: OAuthConnection | string) => Promise<T>,
): Promise<T> {
  if (connection) return call(connection);
  const auth = getReadAuth(undefined);
  const usingUserToken =
    _cachedSlackWriteAuth !== null &&
    _cachedSlackReadAuth !== _cachedSlackWriteAuth;
  try {
    return await call(auth);
  } catch (err) {
    if (
      usingUserToken &&
      err instanceof SlackApiError &&
      err.status === 401 &&
      _cachedSlackWriteAuth
    ) {
      _cachedSlackReadAuth = _cachedSlackWriteAuth;
      return call(_cachedSlackWriteAuth);
    }
    throw err;
  }
}

async function resolveUserName(
  auth: OAuthConnection | string,
  userId: string,
): Promise<string> {
  return (await resolveUserInfo(auth, userId)).displayName;
}

async function resolveUserInfo(
  auth: OAuthConnection | string,
  userId: string,
): Promise<NormalizedSlackUserInfo> {
  if (!userId) return { displayName: "unknown" };
  const cacheKey = slackUserInfoCacheKey(auth, userId);
  const cached = userInfoCache.get(cacheKey);
  if (cached) return (await cached).info;

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
  userInfoCache.set(cacheKey, resolved);
  return (await resolved).info;
}

async function resolveUserInfoUncached(
  auth: OAuthConnection | string,
  userId: string,
): Promise<SlackUserInfoLookupResult> {
  let contactDisplayName: string | undefined;
  try {
    const result = findContactChannel({
      channelType: "slack",
      externalUserId: userId,
    });
    if (result) {
      contactDisplayName = result.contact.displayName;
    }
  } catch {
    // Contact lookup failures are non-fatal — fall through to API
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

function slackUserInfoCacheKey(
  auth: OAuthConnection | string,
  userId: string,
): string {
  const authScope =
    typeof auth === "string"
      ? `token:${createHash("sha256").update(auth).digest("hex")}`
      : `connection:${auth.id}:${auth.accountInfo ?? ""}`;
  return `${authScope}:user:${userId}`;
}

function normalizeSlackUserInfo(
  user: SlackUser,
  contactDisplayName: string | undefined,
): NormalizedSlackUserInfo {
  const displayName =
    contactDisplayName ||
    user.profile?.display_name ||
    user.profile?.real_name ||
    user.real_name ||
    user.name ||
    user.id;
  const timezone = trimNonEmpty(user.tz);
  const timezoneLabel = trimNonEmpty(user.tz_label);
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

function trimNonEmpty(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function __resetSlackUserInfoCacheForTests(): void {
  userInfoCache.clear();
}

function slackUserInfoMetadata(
  userInfo: NormalizedSlackUserInfo | undefined,
): Record<string, unknown> {
  if (!userInfo) return {};
  return {
    ...(userInfo.timezone ? { actorTimezone: userInfo.timezone } : {}),
    ...(userInfo.timezoneLabel
      ? { actorTimezoneLabel: userInfo.timezoneLabel }
      : {}),
    ...(userInfo.timezoneOffsetSeconds !== undefined
      ? { actorTimezoneOffsetSeconds: userInfo.timezoneOffsetSeconds }
      : {}),
  };
}

function mapConversationType(conv: SlackConversation): Conversation["type"] {
  if (conv.is_im) return "dm";
  if (conv.is_mpim) return "group";
  if (conv.is_group) return "group";
  return "channel";
}

function mapConversation(conv: SlackConversation): Conversation {
  const latestTs = conv.latest?.ts ? parseFloat(conv.latest.ts) * 1000 : 0;
  return {
    id: conv.id,
    name: conv.name ?? conv.id,
    type: mapConversationType(conv),
    platform: "slack",
    unreadCount: conv.unread_count_display ?? conv.unread_count ?? 0,
    lastActivityAt: latestTs,
    memberCount: conv.num_members,
    topic: conv.topic?.value || undefined,
    isArchived: conv.is_archived,
    isPrivate: conv.is_private ?? conv.is_group ?? false,
    metadata: conv.is_im ? { dmUserId: conv.user } : undefined,
  };
}

function mapSlackFiles(files: SlackMessage["files"]):
  | Array<{
      id?: string;
      name: string;
      mimetype?: string;
      /**
       * Transient — only present on the in-flight `ProviderMessage.metadata`.
       * The persisted `slackFiles` shape carries `{ id, name, mimetype }` only
       * (see `slackFileMetadataSchema`). Callers that hydrate image attachments
       * during backfill rely on this URL; persistence strips it before write.
       */
      urlPrivateDownload?: string;
      urlPrivate?: string;
    }>
  | undefined {
  if (!files || files.length === 0) return undefined;
  const mapped = files
    .map((file) => ({
      ...(file.id ? { id: file.id } : {}),
      name: file.name,
      ...(file.mimetype ? { mimetype: file.mimetype } : {}),
      ...(file.url_private_download
        ? { urlPrivateDownload: file.url_private_download }
        : {}),
      ...(file.url_private ? { urlPrivate: file.url_private } : {}),
    }))
    .filter((file) => file.name.length > 0);
  return mapped.length > 0 ? mapped : undefined;
}

function mapMessage(
  msg: SlackMessage,
  channelId: string,
  senderInfo: NormalizedSlackUserInfo,
  renderedText: string,
): Message {
  // Bot-authored when Slack sets `subtype: "bot_message"` or attributes the
  // row to a `bot_id` with no user. Backfill callers use this flag for
  // bot-specific filtering while preserving real bot rows as channel replay.
  const isBot =
    msg.subtype === "bot_message" || (msg.bot_id != null && !msg.user);
  const slackFiles = mapSlackFiles(msg.files);
  const slackBotId = msg.bot_id?.trim();
  const userMetadata = slackUserInfoMetadata(msg.user ? senderInfo : undefined);
  const hasUserMetadata = Object.keys(userMetadata).length > 0;
  return {
    id: msg.ts,
    conversationId: channelId,
    sender: {
      id: msg.user ?? msg.bot_id ?? "unknown",
      name: senderInfo.displayName,
    },
    text: renderedText,
    timestamp: parseFloat(msg.ts) * 1000,
    threadId: msg.thread_ts,
    replyCount: msg.reply_count,
    platform: "slack",
    reactions: msg.reactions?.map((r) => ({ name: r.name, count: r.count })),
    hasAttachments: (msg.files?.length ?? 0) > 0,
    ...(isBot || slackFiles || hasUserMetadata
      ? {
          metadata: {
            ...(isBot ? { isBot: true } : {}),
            ...(slackBotId ? { slackBotId } : {}),
            ...(slackFiles ? { slackFiles } : {}),
            ...userMetadata,
          },
        }
      : {}),
  };
}

function mapSearchMatch(
  match: SlackSearchMatch,
  userLabels: Record<string, string>,
): Message {
  return {
    id: match.ts,
    conversationId: match.channel.id,
    sender: { id: match.user ?? "unknown", name: match.username ?? "unknown" },
    text: renderSlackTextForModel(match.text, { userLabels }),
    timestamp: parseFloat(match.ts) * 1000,
    threadId: match.thread_ts,
    platform: "slack",
    metadata: { permalink: match.permalink, channelName: match.channel.name },
  };
}

async function mapSlackMessages(
  auth: OAuthConnection | string,
  channelId: string,
  slackMessages: SlackMessage[],
): Promise<Message[]> {
  const userLabels = await buildMentionUserLabels(
    auth,
    slackMessages.map((msg) => msg.text),
  );
  const messages: Message[] = [];
  for (const msg of slackMessages) {
    const senderInfo = await resolveUserInfo(auth, msg.user ?? "");
    messages.push(
      mapMessage(
        msg,
        channelId,
        senderInfo,
        renderSlackTextForModel(msg.text, { userLabels }),
      ),
    );
  }
  return messages;
}

async function buildMentionUserLabels(
  auth: OAuthConnection | string,
  textValues: Iterable<string | undefined>,
): Promise<Record<string, string>> {
  return buildSlackUserLabelMap(textValues, (userId) =>
    resolveUserName(auth, userId),
  );
}

async function mapSearchMatches(
  auth: OAuthConnection | string,
  matches: SlackSearchMatch[],
): Promise<Message[]> {
  const userLabels = await buildMentionUserLabels(
    auth,
    matches.map((match) => match.text),
  );
  return matches.map((match) => mapSearchMatch(match, userLabels));
}

export const slackProvider: MessagingProvider = {
  id: "slack",
  displayName: "Slack",
  credentialService: "slack",
  capabilities: new Set([
    "reactions",
    "threads",
    "join_channel",
    "leave_channel",
  ]),

  async isConnected(): Promise<boolean> {
    // Socket Mode: check for bot token directly in credential store.
    // The token is the source of truth; the slack_channel connection row
    // is advisory (backfill can fail non-fatally on startup).
    const botToken = await getSecureKeyAsync(
      credentialKey("slack_channel", "bot_token"),
    );
    if (botToken) return true;
    // Preserve existing OAuth path for backwards compat.
    return isProviderConnected("slack");
  },

  async resolveConnection(
    account?: string,
  ): Promise<OAuthConnection | undefined> {
    // Socket Mode: cache the raw bot token for use in adapter methods.
    // Token presence is sufficient — no connection row required.
    //
    // When a user_token is also stored, prefer it for reads so the adapter
    // can see channels the user is in but the bot isn't (conversations.list,
    // conversations.history, search.messages). Writes always stay on the
    // bot token — see SAFETY note above getWriteAuth().
    const botToken = await getSecureKeyAsync(
      credentialKey("slack_channel", "bot_token"),
    );
    const userToken = await getSecureKeyAsync(
      credentialKey("slack_channel", "user_token"),
    );
    if (botToken) {
      _cachedSlackWriteAuth = botToken;
      _cachedSlackReadAuth = userToken ?? botToken;
      return undefined;
    }
    // Preserve existing OAuth path for backwards compat.
    const conn = await resolveOAuthConnection("slack", { account });
    _cachedSlackWriteAuth = conn;
    _cachedSlackReadAuth = conn;
    return conn;
  },

  async testConnection(connection?: OAuthConnection): Promise<ConnectionInfo> {
    const auth = getSlackAuth(connection);
    const resp = await slack.authTest(auth);
    return {
      connected: true,
      user: resp.user,
      platform: "slack",
      metadata: { team: resp.team, teamId: resp.team_id, userId: resp.user_id },
    };
  },

  async listConversations(
    connection: OAuthConnection | undefined,
    options?: ListOptions,
  ): Promise<Conversation[]> {
    const typeMap: Record<string, string> = {
      channel: "public_channel,private_channel",
      dm: "im",
      group: "mpim",
    };

    let types: string;
    if (options?.types?.length) {
      types = options.types.map((t) => typeMap[t] ?? t).join(",");
    } else {
      types = "public_channel,private_channel,mpim,im";
    }

    const conversations: Conversation[] = [];
    let cursor: string | undefined = options?.cursor;
    let auth = getReadAuth(connection);

    // Paginate through all results. The first page is wrapped in
    // runReadWithFallback so that a 401 on the user token retries with the
    // bot token before we commit to the rest of the pagination.
    let firstPage = true;
    do {
      const resp = firstPage
        ? await runReadWithFallback(connection, async (a) => {
            auth = a;
            return slack.listConversations(
              a,
              types,
              options?.excludeArchived ?? true,
              options?.limit ?? 200,
              cursor,
            );
          })
        : await slack.listConversations(
            auth,
            types,
            options?.excludeArchived ?? true,
            options?.limit ?? 200,
            cursor,
          );
      firstPage = false;
      conversations.push(...resp.channels.map(mapConversation));
      cursor = resp.response_metadata?.next_cursor || undefined;
    } while (
      cursor &&
      (!options?.limit || conversations.length < options.limit)
    );

    // Resolve DM user names and cache channel mappings
    for (const conv of conversations) {
      if (conv.type === "dm" && conv.metadata?.dmUserId) {
        const dmUserId = conv.metadata.dmUserId as string;
        conv.name = await resolveUserName(auth, dmUserId);
      }
    }

    return conversations;
  },

  async getHistory(
    connection: OAuthConnection | undefined,
    conversationId: string,
    options?: HistoryOptions,
  ): Promise<Message[]> {
    let auth: OAuthConnection | string = getReadAuth(connection);
    const resp = await runReadWithFallback(connection, async (a) => {
      auth = a;
      return slack.conversationHistory(
        a,
        conversationId,
        options?.limit ?? 50,
        options?.before,
        options?.after,
        options?.cursor,
        options?.inclusive,
      );
    });

    return mapSlackMessages(auth, conversationId, resp.messages);
  },

  async search(
    connection: OAuthConnection | undefined,
    query: string,
    options?: SearchOptions,
  ): Promise<SearchResult> {
    let auth: OAuthConnection | string = getReadAuth(connection);
    const resp = await runReadWithFallback(connection, async (a) => {
      auth = a;
      return slack.searchMessages(a, query, options?.count ?? 20);
    });
    return {
      total: resp.messages.total,
      messages: await mapSearchMatches(auth, resp.messages.matches),
      hasMore: resp.messages.paging.page < resp.messages.paging.pages,
    };
  },

  async sendMessage(
    connection: OAuthConnection | undefined,
    conversationId: string,
    text: string,
    options?: SendOptions,
  ): Promise<SendResult> {
    const auth = getWriteAuth(connection);
    const resp = await slack.postMessage(
      auth,
      conversationId,
      text,
      options?.threadId,
    );
    return {
      id: resp.ts,
      timestamp: parseFloat(resp.ts) * 1000,
      conversationId: resp.channel,
    };
  },

  async getThreadReplies(
    connection: OAuthConnection | undefined,
    conversationId: string,
    threadId: string,
    options?: HistoryOptions,
  ): Promise<Message[]> {
    let auth: OAuthConnection | string = getReadAuth(connection);
    const resp = await runReadWithFallback(connection, async (a) => {
      auth = a;
      return slack.conversationReplies(
        a,
        conversationId,
        threadId,
        options?.limit ?? 50,
        options?.before,
        options?.after,
        options?.inclusive,
        options?.cursor,
      );
    });
    return mapSlackMessages(auth, conversationId, resp.messages);
  },

  async getThreadRepliesPage(
    connection: OAuthConnection | undefined,
    conversationId: string,
    threadId: string,
    options?: HistoryOptions,
  ): Promise<HistoryPageResult> {
    let auth: OAuthConnection | string = getReadAuth(connection);
    const resp = await runReadWithFallback(connection, async (a) => {
      auth = a;
      return slack.conversationReplies(
        a,
        conversationId,
        threadId,
        options?.limit ?? 50,
        options?.before,
        options?.after,
        options?.inclusive,
        options?.cursor,
      );
    });
    const nextCursor = resp.response_metadata?.next_cursor || undefined;
    return {
      messages: await mapSlackMessages(auth, conversationId, resp.messages),
      hasMore: Boolean(resp.has_more || nextCursor),
      ...(nextCursor ? { nextCursor } : {}),
    };
  },

  async markRead(
    connection: OAuthConnection | undefined,
    conversationId: string,
    messageId?: string,
  ): Promise<void> {
    // conversations.mark sets the read cursor for the authenticated identity.
    // It must use the same token as the read path so the cursor matches the
    // perspective the adapter exposes (unread counts in listConversations).
    // Slack's conversations.mark requires a timestamp — use the provided one or "now"
    const ts = messageId ?? String(Date.now() / 1000);
    await runReadWithFallback(connection, (auth) =>
      slack.conversationMark(auth, conversationId, ts),
    );
  },
};
