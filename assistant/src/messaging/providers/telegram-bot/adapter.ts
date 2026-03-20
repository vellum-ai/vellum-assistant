/**
 * Telegram Bot messaging provider adapter.
 *
 * Enables proactive outbound messaging to Telegram chats via the gateway's
 * /deliver/telegram endpoint. Unlike Slack/Gmail which use direct API calls
 * with OAuth tokens, Telegram delivery is proxied through the gateway which
 * owns the bot token and handles Telegram API retries.
 *
 * The `connectionOrToken` parameter in MessagingProvider methods is unused
 * for Telegram because delivery is authenticated via the gateway's bearer
 * token, not a per-user OAuth token.
 */

import { getGatewayInternalBaseUrl } from "../../../config/env.js";
import { getOrCreateConversation } from "../../../memory/conversation-key-store.js";
import * as externalConversationStore from "../../../memory/external-conversation-store.js";
import type { OAuthConnection } from "../../../oauth/connection.js";
import { getConnectionByProvider } from "../../../oauth/oauth-store.js";
import { mintDaemonDeliveryToken } from "../../../runtime/auth/token-service.js";
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
import * as telegram from "./client.js";

/** Resolve the gateway base URL. */
function getGatewayUrl(): string {
  return getGatewayInternalBaseUrl();
}

/** Mint a short-lived JWT for authenticating with the gateway. */
function getBearerToken(): string {
  return mintDaemonDeliveryToken();
}

/** Read the Telegram bot token from the credential vault. */
async function getBotToken(): Promise<string | undefined> {
  const { value } = await getSecureKeyAsync(
    credentialKey("telegram", "bot_token"),
  );
  return value;
}

export const telegramBotMessagingProvider: MessagingProvider = {
  id: "telegram",
  displayName: "Telegram",
  credentialService: "telegram",
  capabilities: new Set(["send"]),

  /**
   * Custom connectivity check using both the oauth_connection record AND
   * actual keychain credentials. The connection row alone can become stale
   * if clearTelegramConfig() returns early on a secure-key deletion error
   * without removing the row. Checking both ensures we don't report
   * Telegram as connected when secrets are missing.
   *
   * Both bot_token and webhook_secret are required — the gateway's
   * /deliver/telegram endpoint rejects requests without the webhook
   * secret, so partial credentials would cause every send to fail.
   */
  async isConnected(): Promise<boolean> {
    const conn = getConnectionByProvider("telegram");
    if (!(conn && conn.status === "active")) return false;
    const botToken = await getBotToken();
    if (!botToken) return false;
    const { value: webhookSecret } = await getSecureKeyAsync(
      credentialKey("telegram", "webhook_secret"),
    );
    return !!webhookSecret;
  },

  async testConnection(
    _connectionOrToken: OAuthConnection | string,
  ): Promise<ConnectionInfo> {
    const botToken = await getBotToken();
    if (!botToken) {
      return {
        connected: false,
        user: "unknown",
        platform: "telegram",
        metadata: {
          error: "No bot token found. Run the telegram-setup skill.",
        },
      };
    }

    try {
      const resp = await telegram.getMe(botToken);
      if (!resp.ok || !resp.result) {
        return {
          connected: false,
          user: "unknown",
          platform: "telegram",
          metadata: { error: resp.description ?? "getMe failed" },
        };
      }

      return {
        connected: true,
        user: resp.result.username ?? resp.result.first_name,
        platform: "telegram",
        metadata: {
          botId: resp.result.id,
          botUsername: resp.result.username,
          botName: resp.result.first_name,
        },
      };
    } catch (e) {
      return {
        connected: false,
        user: "unknown",
        platform: "telegram",
        metadata: { error: e instanceof Error ? e.message : "getMe failed" },
      };
    }
  },

  async sendMessage(
    _connectionOrToken: OAuthConnection | string,
    conversationId: string,
    text: string,
    _options?: SendOptions,
  ): Promise<SendResult> {
    const gatewayUrl = getGatewayUrl();
    const bearerToken = getBearerToken();

    await telegram.sendMessage(gatewayUrl, bearerToken, conversationId, text);

    // Upsert external conversation binding so deleted/reset syncs are
    // resurrected when an outbound message is sent. This ensures the
    // conversation key mapping and binding exist for the next inbound.
    try {
      const sourceChannel = "telegram";
      const conversationKey = `asst:self:${sourceChannel}:${conversationId}`;
      const { conversationId: internalId } =
        getOrCreateConversation(conversationKey);
      externalConversationStore.upsertOutboundBinding({
        conversationId: internalId,
        sourceChannel,
        externalChatId: conversationId,
      });
    } catch {
      // Best-effort — don't fail the send if binding upsert fails
    }

    return {
      id: `tg-${Date.now()}`,
      timestamp: Date.now(),
      conversationId,
    };
  },

  // Telegram Bot API does not support listing conversations. Bots only
  // interact with chats where users have initiated contact or the bot
  // has been added to a group.
  async listConversations(
    _connectionOrToken: OAuthConnection | string,
    _options?: ListOptions,
  ): Promise<Conversation[]> {
    return [];
  },

  // Telegram Bot API does not provide message history retrieval.
  async getHistory(
    _connectionOrToken: OAuthConnection | string,
    _conversationId: string,
    _options?: HistoryOptions,
  ): Promise<Message[]> {
    return [];
  },

  // Telegram Bot API does not support message search.
  async search(
    _connectionOrToken: OAuthConnection | string,
    _query: string,
    _options?: SearchOptions,
  ): Promise<SearchResult> {
    return { total: 0, messages: [], hasMore: false };
  },
};
