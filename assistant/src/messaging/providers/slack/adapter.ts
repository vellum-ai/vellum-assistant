/**
 * Slack messaging provider adapter.
 *
 * Maps Slack API responses to the platform-agnostic messaging types and
 * implements the MessagingProvider interface.
 */

import { findContactChannel } from "../../../contacts/contact-store.js";
import { upsertContactChannel } from "../../../contacts/contacts-write.js";
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
  ListOptions,
  Message,
  SearchOptions,
  SearchResult,
  SendOptions,
  SendResult,
} from "../../provider-types.js";
import * as slack from "./client.js";
import type {
  SlackConversation,
  SlackMessage,
  SlackSearchMatch,
} from "./types.js";

// Cache user display names to avoid repeated API calls within a session
const userNameCache = new Map<string, string>();

/**
 * Cached auth resolved during resolveConnection(), split by direction.
 *
 * Read and write auth are tracked separately so a future change can point
 * reads at a user OAuth token (xoxp-) while writes continue to use the bot
 * token (xoxb-). Today both caches hold the same value (behavior-preserving
 * refactor); PR 5 of the slack-user-token-triage plan wires a user_token
 * into the read cache.
 *
 * For Socket Mode these hold a raw bot token string; for OAuth they hold the
 * OAuthConnection. The Slack client functions accept both via their own
 * OAuthConnection | string union, so we can pass the cached value through
 * directly.
 */
let _cachedSlackWriteAuth: OAuthConnection | string | null = null;
let _cachedSlackReadAuth: OAuthConnection | string | null = null;

/**
 * Get the Slack auth value to pass to Slack client functions.
 * Prefers the explicit connection from the caller; falls back to the cached
 * write auth (which equals the read auth until PR 5 introduces a split).
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

/**
 * Resolve auth for write operations (postMessage, markRead, and any future
 * state-changing method like reactions, joins, leaves, updates, or deletes).
 */
function getWriteAuth(connection?: OAuthConnection): OAuthConnection | string {
  if (connection) return connection;
  if (_cachedSlackWriteAuth) return _cachedSlackWriteAuth;
  return getSlackAuth(connection);
}

async function resolveUserName(
  auth: OAuthConnection | string,
  userId: string,
): Promise<string> {
  if (!userId) return "unknown";
  const cached = userNameCache.get(userId);
  if (cached) return cached;

  // Check contacts DB for a persistent cache hit
  try {
    const result = findContactChannel({
      channelType: "slack",
      externalUserId: userId,
    });
    if (result) {
      const name = result.contact.displayName;
      userNameCache.set(userId, name);
      return name;
    }
  } catch {
    // Contact lookup failures are non-fatal — fall through to API
  }

  try {
    const resp = await slack.userInfo(auth, userId);
    const name =
      resp.user.profile?.display_name ||
      resp.user.profile?.real_name ||
      resp.user.real_name ||
      resp.user.name;
    userNameCache.set(userId, name);

    // Persist to contacts for future sessions
    try {
      upsertContactChannel({
        sourceChannel: "slack",
        externalUserId: userId,
        displayName: name,
      });
    } catch {
      // Non-fatal — caching failure shouldn't break messaging
    }

    return name;
  } catch {
    return userId;
  }
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

function mapMessage(
  msg: SlackMessage,
  channelId: string,
  senderName: string,
): Message {
  return {
    id: msg.ts,
    conversationId: channelId,
    sender: { id: msg.user ?? msg.bot_id ?? "unknown", name: senderName },
    text: msg.text,
    timestamp: parseFloat(msg.ts) * 1000,
    threadId: msg.thread_ts,
    replyCount: msg.reply_count,
    platform: "slack",
    reactions: msg.reactions?.map((r) => ({ name: r.name, count: r.count })),
    hasAttachments: (msg.files?.length ?? 0) > 0,
  };
}

function mapSearchMatch(match: SlackSearchMatch): Message {
  return {
    id: match.ts,
    conversationId: match.channel.id,
    sender: { id: match.user ?? "unknown", name: match.username ?? "unknown" },
    text: match.text,
    timestamp: parseFloat(match.ts) * 1000,
    threadId: match.thread_ts,
    platform: "slack",
    metadata: { permalink: match.permalink, channelName: match.channel.name },
  };
}

export const slackProvider: MessagingProvider = {
  id: "slack",
  displayName: "Slack",
  credentialService: "slack",
  capabilities: new Set(["reactions", "threads", "join_channel", "leave_channel"]),

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
    const botToken = await getSecureKeyAsync(
      credentialKey("slack_channel", "bot_token"),
    );
    if (botToken) {
      _cachedSlackWriteAuth = botToken;
      _cachedSlackReadAuth = botToken; // PR 5 will point this at user_token when available
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
    const auth = getReadAuth(connection);
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

    // Paginate through all results
    do {
      const resp = await slack.listConversations(
        auth,
        types,
        options?.excludeArchived ?? true,
        options?.limit ?? 200,
        cursor,
      );
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

        // Persist the DM channel ID so future sends skip conversations.open
        try {
          const existing = findContactChannel({
            channelType: "slack",
            externalUserId: dmUserId,
          });
          if (existing && !existing.channel.externalChatId) {
            upsertContactChannel({
              contactId: existing.contact.id,
              sourceChannel: "slack",
              externalUserId: dmUserId,
              externalChatId: conv.id,
              displayName: conv.name,
            });
          }
        } catch {
          // Non-fatal
        }
      }
    }

    return conversations;
  },

  async getHistory(
    connection: OAuthConnection | undefined,
    conversationId: string,
    options?: HistoryOptions,
  ): Promise<Message[]> {
    const auth = getReadAuth(connection);
    const resp = await slack.conversationHistory(
      auth,
      conversationId,
      options?.limit ?? 50,
      options?.before,
      options?.after,
    );

    const messages: Message[] = [];
    for (const msg of resp.messages) {
      const name = await resolveUserName(auth, msg.user ?? "");
      messages.push(mapMessage(msg, conversationId, name));
    }

    return messages;
  },

  async search(
    connection: OAuthConnection | undefined,
    query: string,
    options?: SearchOptions,
  ): Promise<SearchResult> {
    const auth = getReadAuth(connection);
    const resp = await slack.searchMessages(auth, query, options?.count ?? 20);
    return {
      total: resp.messages.total,
      messages: resp.messages.matches.map(mapSearchMatch),
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
    const auth = getReadAuth(connection);
    const resp = await slack.conversationReplies(
      auth,
      conversationId,
      threadId,
      options?.limit ?? 50,
    );
    const messages: Message[] = [];
    for (const msg of resp.messages) {
      const name = await resolveUserName(auth, msg.user ?? "");
      messages.push(mapMessage(msg, conversationId, name));
    }
    return messages;
  },

  async markRead(
    connection: OAuthConnection | undefined,
    conversationId: string,
    messageId?: string,
  ): Promise<void> {
    const auth = getWriteAuth(connection);
    // Slack's conversations.mark requires a timestamp — use the provided one or "now"
    const ts = messageId ?? String(Date.now() / 1000);
    await slack.conversationMark(auth, conversationId, ts);
  },
};
