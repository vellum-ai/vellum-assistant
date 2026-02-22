/**
 * Telegram Bot messaging provider adapter.
 *
 * Enables proactive outbound messaging to Telegram chats via the gateway's
 * /deliver/telegram endpoint. Unlike Slack/Gmail which use direct API calls
 * with OAuth tokens, Telegram delivery is proxied through the gateway which
 * owns the bot token and handles Telegram API retries.
 *
 * The `token` parameter in MessagingProvider methods is unused for Telegram
 * because delivery is authenticated via the gateway's bearer token, not
 * a per-user OAuth token.
 */

import type { MessagingProvider } from '../../provider.js';
import type {
  Conversation,
  Message,
  SearchResult,
  SendResult,
  ConnectionInfo,
  ListOptions,
  HistoryOptions,
  SearchOptions,
  SendOptions,
} from '../../provider-types.js';
import { getSecureKey } from '../../../security/secure-keys.js';
import { readHttpToken } from '../../../util/platform.js';
import * as telegram from './client.js';

/** Resolve the gateway base URL, preferring GATEWAY_INTERNAL_BASE_URL if set. */
function getGatewayUrl(): string {
  if (process.env.GATEWAY_INTERNAL_BASE_URL) {
    return process.env.GATEWAY_INTERNAL_BASE_URL.replace(/\/+$/, "");
  }
  const port = Number(process.env.GATEWAY_PORT) || 7830;
  return `http://127.0.0.1:${port}`;
}

/** Read the runtime HTTP bearer token used to authenticate with the gateway. */
function getBearerToken(): string {
  const token = readHttpToken();
  if (!token) {
    throw new Error('No runtime HTTP bearer token available — is the daemon running?');
  }
  return token;
}

/** Read the Telegram bot token from the credential vault. */
function getBotToken(): string | undefined {
  return getSecureKey('credential:telegram:bot_token');
}

export const telegramBotMessagingProvider: MessagingProvider = {
  id: 'telegram',
  displayName: 'Telegram',
  credentialService: 'telegram',
  capabilities: new Set(['send']),

  /**
   * Custom connectivity check. The standard registry check looks for
   * credential:telegram:access_token, but the Telegram bot token is
   * stored as credential:telegram:bot_token. This method lets the
   * registry detect that Telegram credentials exist.
   *
   * Both bot_token and webhook_secret are required — the gateway's
   * /deliver/telegram endpoint rejects requests without the webhook
   * secret, so partial credentials would cause every send to fail.
   */
  isConnected(): boolean {
    return getBotToken() !== undefined && !!getSecureKey('credential:telegram:webhook_secret');
  },

  async testConnection(_token: string): Promise<ConnectionInfo> {
    const botToken = getBotToken();
    if (!botToken) {
      return {
        connected: false,
        user: 'unknown',
        platform: 'telegram',
        metadata: { error: 'No bot token found. Run the telegram-setup skill.' },
      };
    }

    try {
      const resp = await telegram.getMe(botToken);
      if (!resp.ok || !resp.result) {
        return {
          connected: false,
          user: 'unknown',
          platform: 'telegram',
          metadata: { error: resp.description ?? 'getMe failed' },
        };
      }

      return {
        connected: true,
        user: resp.result.username ?? resp.result.first_name,
        platform: 'telegram',
        metadata: {
          botId: resp.result.id,
          botUsername: resp.result.username,
          botName: resp.result.first_name,
        },
      };
    } catch (e) {
      return {
        connected: false,
        user: 'unknown',
        platform: 'telegram',
        metadata: { error: e instanceof Error ? e.message : 'getMe failed' },
      };
    }
  },

  async sendMessage(_token: string, conversationId: string, text: string, _options?: SendOptions): Promise<SendResult> {
    const gatewayUrl = getGatewayUrl();
    const bearerToken = getBearerToken();

    await telegram.sendMessage(gatewayUrl, bearerToken, conversationId, text);

    return {
      id: `tg-${Date.now()}`,
      timestamp: Date.now(),
      conversationId,
    };
  },

  // Telegram Bot API does not support listing conversations. Bots only
  // interact with chats where users have initiated contact or the bot
  // has been added to a group.
  async listConversations(_token: string, _options?: ListOptions): Promise<Conversation[]> {
    return [];
  },

  // Telegram Bot API does not provide message history retrieval.
  async getHistory(_token: string, _conversationId: string, _options?: HistoryOptions): Promise<Message[]> {
    return [];
  },

  // Telegram Bot API does not support message search.
  async search(_token: string, _query: string, _options?: SearchOptions): Promise<SearchResult> {
    return { total: 0, messages: [], hasMore: false };
  },
};
