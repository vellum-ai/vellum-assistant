/**
 * Telegram Bot messaging provider adapter.
 *
 * Calls the Telegram Bot API directly — no gateway proxy hop.
 */

import { getOrCreateConversation } from "../../../memory/conversation-key-store.js";
import { upsertOutboundBinding } from "../../../memory/external-conversation-store.js";
import type { OAuthConnection } from "../../../oauth/connection.js";
import { getConnectionByProvider } from "../../../oauth/oauth-store.js";
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

/** Read the Telegram bot token from the credential vault. */
async function getBotToken(): Promise<string | undefined> {
  return getSecureKeyAsync(credentialKey("telegram", "bot_token"));
}

export const telegramBotMessagingProvider: MessagingProvider = {
  id: "telegram",
  displayName: "Telegram",
  credentialService: "telegram",
  capabilities: new Set(["send"]),

  async isConnected(): Promise<boolean> {
    const conn = getConnectionByProvider("telegram");
    if (!(conn && conn.status === "active")) return false;
    const botToken = await getBotToken();
    if (!botToken) return false;
    const webhookSecret = await getSecureKeyAsync(
      credentialKey("telegram", "webhook_secret"),
    );
    return !!webhookSecret;
  },

  async testConnection(_connection?: OAuthConnection): Promise<ConnectionInfo> {
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
    _connection: OAuthConnection | undefined,
    conversationId: string,
    text: string,
    _options?: SendOptions,
  ): Promise<SendResult> {
    await telegram.sendMessage(conversationId, text);

    // Upsert external conversation binding so deleted/reset syncs are
    // resurrected when an outbound message is sent. This ensures the
    // conversation key mapping and binding exist for the next inbound.
    try {
      const sourceChannel = "telegram";
      const conversationKey = `asst:self:${sourceChannel}:${conversationId}`;
      const { conversationId: internalId } =
        getOrCreateConversation(conversationKey);
      upsertOutboundBinding({
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

  async listConversations(
    _connection?: OAuthConnection,
    _options?: ListOptions,
  ): Promise<Conversation[]> {
    return [];
  },

  async getHistory(
    _connection: OAuthConnection | undefined,
    _conversationId: string,
    _options?: HistoryOptions,
  ): Promise<Message[]> {
    return [];
  },

  async search(
    _connection: OAuthConnection | undefined,
    _query: string,
    _options?: SearchOptions,
  ): Promise<SearchResult> {
    return { total: 0, messages: [], hasMore: false };
  },
};
