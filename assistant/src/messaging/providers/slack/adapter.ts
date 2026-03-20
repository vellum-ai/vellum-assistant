/**
 * Slack messaging provider adapter.
 *
 * Maps Slack API responses to the platform-agnostic messaging types
 * and implements the MessagingProvider interface.
 */

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

async function resolveUserName(
  connectionOrToken: OAuthConnection | string,
  userId: string,
): Promise<string> {
  if (!userId) return "unknown";
  const cached = userNameCache.get(userId);
  if (cached) return cached;

  try {
    const resp = await slack.userInfo(connectionOrToken, userId);
    const name =
      resp.user.profile?.display_name ||
      resp.user.profile?.real_name ||
      resp.user.real_name ||
      resp.user.name;
    userNameCache.set(userId, name);
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
  credentialService: "integration:slack",
  capabilities: new Set(["reactions", "threads", "leave_channel"]),

  async isConnected(): Promise<boolean> {
    // Socket Mode: check for bot token directly in credential store.
    // The token is the source of truth; the slack_channel connection row
    // is advisory (backfill can fail non-fatally on startup).
    const botToken = await getSecureKeyAsync(
      credentialKey("slack_channel", "bot_token"),
    );
    if (botToken) return true;
    // Preserve existing OAuth path (integration:slack) for backwards compat.
    return isProviderConnected("integration:slack");
  },

  async resolveConnection(account?: string): Promise<OAuthConnection | string> {
    // Socket Mode: return raw bot token if available.
    // Token presence is sufficient — no connection row required.
    const botToken = await getSecureKeyAsync(
      credentialKey("slack_channel", "bot_token"),
    );
    if (botToken) return botToken;
    // Preserve existing OAuth path (integration:slack) for backwards compat.
    return resolveOAuthConnection("integration:slack", { account });
  },

  async testConnection(
    connectionOrToken: OAuthConnection | string,
  ): Promise<ConnectionInfo> {
    const resp = await slack.authTest(connectionOrToken);
    return {
      connected: true,
      user: resp.user,
      platform: "slack",
      metadata: { team: resp.team, teamId: resp.team_id, userId: resp.user_id },
    };
  },

  async listConversations(
    connectionOrToken: OAuthConnection | string,
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

    // Paginate through all results
    do {
      const resp = await slack.listConversations(
        connectionOrToken,
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

    // Resolve DM user names
    for (const conv of conversations) {
      if (conv.type === "dm" && conv.metadata?.dmUserId) {
        conv.name = await resolveUserName(
          connectionOrToken,
          conv.metadata.dmUserId as string,
        );
      }
    }

    return conversations;
  },

  async getHistory(
    connectionOrToken: OAuthConnection | string,
    conversationId: string,
    options?: HistoryOptions,
  ): Promise<Message[]> {
    const resp = await slack.conversationHistory(
      connectionOrToken,
      conversationId,
      options?.limit ?? 50,
      options?.before,
      options?.after,
    );

    const messages: Message[] = [];
    for (const msg of resp.messages) {
      const name = await resolveUserName(connectionOrToken, msg.user ?? "");
      messages.push(mapMessage(msg, conversationId, name));
    }

    return messages;
  },

  async search(
    connectionOrToken: OAuthConnection | string,
    query: string,
    options?: SearchOptions,
  ): Promise<SearchResult> {
    const resp = await slack.searchMessages(
      connectionOrToken,
      query,
      options?.count ?? 20,
    );
    return {
      total: resp.messages.total,
      messages: resp.messages.matches.map(mapSearchMatch),
      hasMore: resp.messages.paging.page < resp.messages.paging.pages,
    };
  },

  async sendMessage(
    connectionOrToken: OAuthConnection | string,
    conversationId: string,
    text: string,
    options?: SendOptions,
  ): Promise<SendResult> {
    const resp = await slack.postMessage(
      connectionOrToken,
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
    connectionOrToken: OAuthConnection | string,
    conversationId: string,
    threadId: string,
    options?: HistoryOptions,
  ): Promise<Message[]> {
    const resp = await slack.conversationReplies(
      connectionOrToken,
      conversationId,
      threadId,
      options?.limit ?? 50,
    );
    const messages: Message[] = [];
    for (const msg of resp.messages) {
      const name = await resolveUserName(connectionOrToken, msg.user ?? "");
      messages.push(mapMessage(msg, conversationId, name));
    }
    return messages;
  },

  async markRead(
    connectionOrToken: OAuthConnection | string,
    conversationId: string,
    messageId?: string,
  ): Promise<void> {
    // Slack's conversations.mark requires a timestamp — use the provided one or "now"
    const ts = messageId ?? String(Date.now() / 1000);
    await slack.conversationMark(connectionOrToken, conversationId, ts);
  },
};
