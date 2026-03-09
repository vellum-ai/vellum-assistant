/**
 * WhatsApp Business messaging provider adapter.
 *
 * Enables proactive outbound WhatsApp messaging via the gateway's /deliver/whatsapp
 * endpoint. Delivery is proxied through the gateway which owns the Meta Cloud API
 * credentials (phone_number_id + access_token).
 *
 * The `token` parameter in MessagingProvider methods is unused for WhatsApp
 * because delivery is authenticated via the gateway's bearer token, not
 * a per-user OAuth token.
 */

import { getGatewayInternalBaseUrl } from "../../../config/env.js";
import { getOrCreateConversation } from "../../../memory/conversation-key-store.js";
import * as externalConversationStore from "../../../memory/external-conversation-store.js";
import { mintDaemonDeliveryToken } from "../../../runtime/auth/token-service.js";
import { getSecureKey } from "../../../security/secure-keys.js";
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
import * as whatsapp from "./client.js";

/** Resolve the gateway base URL. */
function getGatewayUrl(): string {
  return getGatewayInternalBaseUrl();
}

/** Mint a short-lived JWT for authenticating with the gateway. */
function getBearerToken(): string {
  return mintDaemonDeliveryToken();
}

/** Check whether WhatsApp credentials are stored. */
function hasWhatsAppCredentials(): boolean {
  return (
    !!getSecureKey("credential:whatsapp:phone_number_id") &&
    !!getSecureKey("credential:whatsapp:access_token")
  );
}

export const whatsappMessagingProvider: MessagingProvider = {
  id: "whatsapp",
  displayName: "WhatsApp",
  credentialService: "whatsapp",
  capabilities: new Set(["send"]),

  /**
   * WhatsApp is connected when Meta Cloud API credentials are stored.
   */
  isConnected(): boolean {
    return hasWhatsAppCredentials();
  },

  async testConnection(_token: string): Promise<ConnectionInfo> {
    if (!hasWhatsAppCredentials()) {
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

    const phoneNumberId = getSecureKey("credential:whatsapp:phone_number_id")!;

    return {
      connected: true,
      user: phoneNumberId,
      platform: "whatsapp",
      metadata: {
        phoneNumberId: phoneNumberId.slice(0, 6) + "...",
      },
    };
  },

  async sendMessage(
    _token: string,
    conversationId: string,
    text: string,
    options?: SendOptions,
  ): Promise<SendResult> {
    const gatewayUrl = getGatewayUrl();
    const bearerToken = getBearerToken();
    const assistantId = options?.assistantId;

    await whatsapp.sendMessage(
      gatewayUrl,
      bearerToken,
      conversationId,
      text,
      assistantId,
    );

    // Upsert external conversation binding so the conversation key mapping
    // exists for the next inbound WhatsApp message from this number.
    try {
      const sourceChannel = "whatsapp";
      const conversationKey = `asst:${assistantId ?? "self"}:${sourceChannel}:${conversationId}`;
      const { conversationId: internalId } =
        getOrCreateConversation(conversationKey);
      if (!assistantId || assistantId === "self") {
        externalConversationStore.upsertOutboundBinding({
          conversationId: internalId,
          sourceChannel,
          externalChatId: conversationId,
        });
      }
    } catch {
      // Best-effort — don't fail the send if binding upsert fails
    }

    return {
      id: `whatsapp-${Date.now()}`,
      timestamp: Date.now(),
      conversationId,
    };
  },

  // WhatsApp does not support listing conversations via this provider.
  async listConversations(
    _token: string,
    _options?: ListOptions,
  ): Promise<Conversation[]> {
    return [];
  },

  // WhatsApp does not provide message history retrieval via the gateway.
  async getHistory(
    _token: string,
    _conversationId: string,
    _options?: HistoryOptions,
  ): Promise<Message[]> {
    return [];
  },

  // WhatsApp does not support message search.
  async search(
    _token: string,
    _query: string,
    _options?: SearchOptions,
  ): Promise<SearchResult> {
    return { total: 0, messages: [], hasMore: false };
  },
};
