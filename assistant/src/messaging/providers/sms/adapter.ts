/**
 * SMS messaging provider adapter.
 *
 * Enables proactive outbound SMS messaging via the gateway's /deliver/sms
 * endpoint. Similar to the Telegram provider, SMS delivery is proxied through
 * the gateway which owns the Twilio credentials and handles the Messages API.
 *
 * Twilio credentials (account_sid, auth_token) and a configured phone number
 * are required for connectivity. The phone number is resolved from the config
 * (sms.phoneNumber), env var (TWILIO_PHONE_NUMBER), or secure key fallback.
 *
 * The `token` parameter in MessagingProvider methods is unused for SMS
 * because delivery is authenticated via the gateway's bearer token, not
 * a per-user OAuth token.
 */

import {
  getTwilioCredentials,
  hasTwilioCredentials,
} from "../../../calls/twilio-rest.js";
import {
  getGatewayInternalBaseUrl,
  getTwilioPhoneNumberEnv,
} from "../../../config/env.js";
import { loadConfig } from "../../../config/loader.js";
import { getOrCreateConversation } from "../../../memory/conversation-key-store.js";
import * as externalConversationStore from "../../../memory/external-conversation-store.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../../../runtime/assistant-scope.js";
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
import * as sms from "./client.js";

/** Resolve the gateway base URL, preferring GATEWAY_INTERNAL_BASE_URL if set. */
function getGatewayUrl(): string {
  return getGatewayInternalBaseUrl();
}

/** Mint a short-lived JWT for authenticating with the gateway. */
function getBearerToken(): string {
  return mintDaemonDeliveryToken();
}

/** Resolve the configured SMS phone number. */
function getPhoneNumber(): string | undefined {
  const fromEnv = getTwilioPhoneNumberEnv();
  if (fromEnv) return fromEnv;

  try {
    const config = loadConfig();
    if (config.sms?.phoneNumber) return config.sms.phoneNumber;
  } catch {
    // Config may not be available yet during early startup
  }

  return getSecureKey("credential:twilio:phone_number") || undefined;
}

export const smsMessagingProvider: MessagingProvider = {
  id: "sms",
  displayName: "SMS",
  credentialService: "twilio",
  capabilities: new Set(["send"]),

  /**
   * SMS is connected when Twilio credentials are stored AND a phone number
   * is configured. Without a phone number the gateway cannot determine
   * the `from` for outbound messages.
   */
  isConnected(): boolean {
    if (!hasTwilioCredentials()) return false;
    if (getPhoneNumber()) return true;
    try {
      const config = loadConfig();
      const mappings = config.sms?.assistantPhoneNumbers as
        | Record<string, string>
        | undefined;
      if (mappings && Object.keys(mappings).length > 0) return true;
    } catch {
      // Config may not be available yet
    }
    return false;
  },

  async testConnection(_token: string): Promise<ConnectionInfo> {
    if (!hasTwilioCredentials()) {
      return {
        connected: false,
        user: "unknown",
        platform: "sms",
        metadata: {
          error: "No Twilio credentials found. Run the twilio-setup skill.",
        },
      };
    }

    const phoneNumber = getPhoneNumber();
    if (!phoneNumber) {
      // Mirror isConnected(): fall back to assistant-scoped phone numbers
      try {
        const config = loadConfig();
        const mappings = config.sms?.assistantPhoneNumbers as
          | Record<string, string>
          | undefined;
        if (mappings && Object.keys(mappings).length > 0) {
          const accountSid = getTwilioCredentials().accountSid;
          return {
            connected: true,
            user: "assistant-scoped",
            platform: "sms",
            metadata: {
              accountSid: accountSid.slice(0, 6) + "...",
              assistantPhoneNumbers: Object.keys(mappings).length,
            },
          };
        }
      } catch {
        // Config may not be available yet
      }
      return {
        connected: false,
        user: "unknown",
        platform: "sms",
        metadata: {
          error:
            "No phone number configured. Run the twilio-setup skill to assign a number.",
        },
      };
    }

    const accountSid = getTwilioCredentials().accountSid;

    return {
      connected: true,
      user: phoneNumber,
      platform: "sms",
      metadata: {
        accountSid: accountSid.slice(0, 6) + "...",
        phoneNumber,
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

    const sendResult = await sms.sendMessage(
      gatewayUrl,
      bearerToken,
      conversationId,
      text,
      assistantId,
    );

    // Upsert external conversation binding so the conversation key mapping
    // exists for the next inbound SMS from this number.
    const isSelfScope =
      !assistantId || assistantId === DAEMON_INTERNAL_ASSISTANT_ID;
    try {
      const sourceChannel = "sms";
      const conversationKey = isSelfScope
        ? `${sourceChannel}:${conversationId}`
        : `asst:${assistantId}:${sourceChannel}:${conversationId}`;
      const { conversationId: internalId } =
        getOrCreateConversation(conversationKey);
      if (isSelfScope) {
        externalConversationStore.upsertOutboundBinding({
          conversationId: internalId,
          sourceChannel,
          externalChatId: conversationId,
        });
      }
    } catch {
      // Best-effort — don't fail the send if binding upsert fails
    }

    // Use the Twilio message SID as the send result ID when available,
    // falling back to a timestamp-based ID for older gateway versions.
    const id = sendResult.messageSid || `sms-${Date.now()}`;

    return {
      id,
      timestamp: Date.now(),
      conversationId,
    };
  },

  // SMS does not support listing conversations. The assistant can only
  // send to known phone numbers (conversation IDs).
  async listConversations(
    _token: string,
    _options?: ListOptions,
  ): Promise<Conversation[]> {
    return [];
  },

  // SMS does not provide message history retrieval via the gateway.
  async getHistory(
    _token: string,
    _conversationId: string,
    _options?: HistoryOptions,
  ): Promise<Message[]> {
    return [];
  },

  // SMS does not support message search.
  async search(
    _token: string,
    _query: string,
    _options?: SearchOptions,
  ): Promise<SearchResult> {
    return { total: 0, messages: [], hasMore: false };
  },
};
