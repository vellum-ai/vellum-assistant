/**
 * WhatsApp Business messaging provider adapter.
 *
 * Calls the Meta Cloud API directly — no gateway proxy hop.
 */

import type { OAuthConnection } from "../../../oauth/connection.js";
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
} from "../../provider-types.js";

/** Check whether WhatsApp credentials are stored. */
async function hasWhatsAppCredentials(): Promise<boolean> {
  const phoneNumberId = await getSecureKeyAsync(
    credentialKey("whatsapp", "phone_number_id"),
  );
  if (!phoneNumberId) {
    return false;
  }
  const accessToken = await getSecureKeyAsync(
    credentialKey("whatsapp", "access_token"),
  );
  return !!accessToken;
}

export const whatsappMessagingProvider: MessagingProvider = {
  id: "whatsapp",
  displayName: "WhatsApp",
  credentialService: "whatsapp",
  capabilities: new Set(),

  async isConnected(): Promise<boolean> {
    return hasWhatsAppCredentials();
  },

  async testConnection(_connection?: OAuthConnection): Promise<ConnectionInfo> {
    if (!(await hasWhatsAppCredentials())) {
      return {
        connected: false,
        user: "unknown",
        platform: "whatsapp",
        metadata: {
          error:
            "No WhatsApp credentials found. Configure WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN.",
        },
      };
    }

    const phoneNumberId = (await getSecureKeyAsync(
      credentialKey("whatsapp", "phone_number_id"),
    ))!;

    return {
      connected: true,
      user: phoneNumberId,
      platform: "whatsapp",
      metadata: {
        phoneNumberId: phoneNumberId.slice(0, 6) + "...",
      },
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
