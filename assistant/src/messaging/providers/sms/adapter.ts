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
import { readHttpToken, readLockfile } from '../../../util/platform.js';
import { loadConfig } from '../../../config/loader.js';
import { getOrCreateConversation } from '../../../memory/conversation-key-store.js';
import * as externalConversationStore from '../../../memory/external-conversation-store.js';
import * as sms from './client.js';

/** Resolve the gateway base URL, preferring GATEWAY_INTERNAL_BASE_URL if set. */
function getGatewayUrl(): string {
  if (process.env.GATEWAY_INTERNAL_BASE_URL) {
    return process.env.GATEWAY_INTERNAL_BASE_URL.replace(/\/+$/, '');
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

/** Check whether Twilio credentials are stored. */
function hasTwilioCredentials(): boolean {
  return (
    !!getSecureKey('credential:twilio:account_sid') &&
    !!getSecureKey('credential:twilio:auth_token')
  );
}

/**
 * Read the current assistantId from the lockfile.
 * Returns the most recently hatched assistant's ID, or undefined if unavailable.
 */
function getAssistantId(): string | undefined {
  try {
    const lockData = readLockfile();
    const assistants = lockData?.assistants as Array<Record<string, unknown>> | undefined;
    if (assistants && assistants.length > 0) {
      const sorted = [...assistants].sort((a, b) => {
        const dateA = new Date(a.hatchedAt as string || 0).getTime();
        const dateB = new Date(b.hatchedAt as string || 0).getTime();
        return dateB - dateA;
      });
      return sorted[0].assistantId as string | undefined;
    }
  } catch {
    // ignore — lockfile may not exist
  }
  return undefined;
}

/**
 * Resolve the configured SMS phone number.
 * Priority: assistant-scoped phone number > TWILIO_PHONE_NUMBER env > config sms.phoneNumber > secure key fallback.
 */
function getPhoneNumber(assistantId?: string): string | undefined {
  // Check assistant-scoped phone number first
  if (assistantId) {
    try {
      const config = loadConfig();
      const assistantPhone = config.sms?.assistantPhoneNumbers?.[assistantId];
      if (assistantPhone) return assistantPhone;
    } catch {
      // Config may not be available yet during early startup
    }
  }

  const fromEnv = process.env.TWILIO_PHONE_NUMBER;
  if (fromEnv) return fromEnv;

  try {
    const config = loadConfig();
    if (config.sms?.phoneNumber) return config.sms.phoneNumber;
  } catch {
    // Config may not be available yet during early startup
  }

  return getSecureKey('credential:twilio:phone_number') || undefined;
}

export const smsMessagingProvider: MessagingProvider = {
  id: 'sms',
  displayName: 'SMS',
  credentialService: 'twilio',
  capabilities: new Set(['send']),

  /**
   * SMS is connected when Twilio credentials are stored AND a phone number
   * is configured. Without a phone number the gateway cannot determine
   * the `from` for outbound messages.
   */
  isConnected(): boolean {
    return hasTwilioCredentials() && !!getPhoneNumber(getAssistantId());
  },

  async testConnection(_token: string): Promise<ConnectionInfo> {
    if (!hasTwilioCredentials()) {
      return {
        connected: false,
        user: 'unknown',
        platform: 'sms',
        metadata: { error: 'No Twilio credentials found. Run the twilio-setup skill.' },
      };
    }

    const phoneNumber = getPhoneNumber(getAssistantId());
    if (!phoneNumber) {
      return {
        connected: false,
        user: 'unknown',
        platform: 'sms',
        metadata: { error: 'No phone number configured. Run the twilio-setup skill to assign a number.' },
      };
    }

    const accountSid = getSecureKey('credential:twilio:account_sid')!;

    return {
      connected: true,
      user: phoneNumber,
      platform: 'sms',
      metadata: {
        accountSid: accountSid.slice(0, 6) + '...',
        phoneNumber,
      },
    };
  },

  async sendMessage(_token: string, conversationId: string, text: string, _options?: SendOptions): Promise<SendResult> {
    const gatewayUrl = getGatewayUrl();
    const bearerToken = getBearerToken();
    const assistantId = getAssistantId();

    await sms.sendMessage(gatewayUrl, bearerToken, conversationId, text, assistantId);

    // Upsert external conversation binding so the conversation key mapping
    // exists for the next inbound SMS from this number.
    try {
      const sourceChannel = 'sms';
      const conversationKey = `${sourceChannel}:${conversationId}`;
      const { conversationId: internalId } = getOrCreateConversation(conversationKey);
      externalConversationStore.upsertOutboundBinding({
        conversationId: internalId,
        sourceChannel,
        externalChatId: conversationId,
      });
    } catch {
      // Best-effort — don't fail the send if binding upsert fails
    }

    return {
      id: `sms-${Date.now()}`,
      timestamp: Date.now(),
      conversationId,
    };
  },

  // SMS does not support listing conversations. The assistant can only
  // send to known phone numbers (conversation IDs).
  async listConversations(_token: string, _options?: ListOptions): Promise<Conversation[]> {
    return [];
  },

  // SMS does not provide message history retrieval via the gateway.
  async getHistory(_token: string, _conversationId: string, _options?: HistoryOptions): Promise<Message[]> {
    return [];
  },

  // SMS does not support message search.
  async search(_token: string, _query: string, _options?: SearchOptions): Promise<SearchResult> {
    return { total: 0, messages: [], hasMore: false };
  },
};
