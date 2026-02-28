/**
 * Telegram channel invite transport adapter.
 *
 * Builds `https://t.me/<botUsername>?start=iv_<token>` deep links and
 * extracts invite tokens from `/start` command payloads.
 *
 * The canonical format uses `iv_` to distinguish invite tokens from `gv_`
 * (guardian verification) tokens that use the same `/start` deep-link
 * mechanism. For defensive compatibility, bare raw invite tokens are also
 * accepted when they match the invite-token shape.
 */

import type { ChannelId } from '../../channels/types.js';
import { getCredentialMetadata } from '../../tools/credentials/metadata-store.js';
import {
  type ChannelInviteTransport,
  type InviteSharePayload,
  registerTransport,
} from '../channel-invite-transport.js';

// ---------------------------------------------------------------------------
// Bot username resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the Telegram bot username from credential metadata, falling back
 * to the TELEGRAM_BOT_USERNAME environment variable. Mirrors the resolution
 * strategy used in `guardian-outbound-actions.ts`.
 */
function getTelegramBotUsername(): string | undefined {
  const meta = getCredentialMetadata('telegram', 'bot_token');
  if (meta?.accountInfo && typeof meta.accountInfo === 'string' && meta.accountInfo.trim().length > 0) {
    return meta.accountInfo.trim();
  }
  return process.env.TELEGRAM_BOT_USERNAME || undefined;
}

// ---------------------------------------------------------------------------
// Token prefix
// ---------------------------------------------------------------------------

const INVITE_TOKEN_PREFIX = 'iv_';
const LEGACY_RAW_INVITE_TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;

function extractTokenFromStartPayload(payload: string): string | undefined {
  const trimmed = payload.trim();
  if (trimmed.length === 0) return undefined;

  // Canonical format: /start iv_<token>
  if (trimmed.startsWith(INVITE_TOKEN_PREFIX)) {
    const token = trimmed.slice(INVITE_TOKEN_PREFIX.length);
    if (token.length > 0 && token.trim().length > 0) {
      return token;
    }
    return undefined;
  }

  // Keep guardian bootstrap tokens on their own control-plane path.
  if (trimmed.startsWith('gv_')) {
    return undefined;
  }

  // Backward/defensive compatibility: accept bare raw invite tokens in
  // /start payloads. This covers links shared without the iv_ prefix.
  if (LEGACY_RAW_INVITE_TOKEN_RE.test(trimmed)) {
    return trimmed;
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Transport implementation
// ---------------------------------------------------------------------------

export const telegramInviteTransport: ChannelInviteTransport = {
  channel: 'telegram' as ChannelId,

  buildShareableInvite(params: {
    rawToken: string;
    sourceChannel: ChannelId;
  }): InviteSharePayload {
    const botUsername = getTelegramBotUsername();
    if (!botUsername) {
      throw new Error('Telegram bot username is not configured. Set up the Telegram integration first.');
    }

    const url = `https://t.me/${botUsername}?start=${INVITE_TOKEN_PREFIX}${params.rawToken}`;
    return {
      url,
      displayText: `Open in Telegram: ${url}`,
    };
  },

  extractInboundToken(params: {
    commandIntent?: Record<string, unknown>;
    content: string;
    sourceMetadata?: Record<string, unknown>;
  }): string | undefined {
    // Primary path: structured command intent from the gateway.
    // The gateway normalizes `/start <payload>` into
    // `{ type: 'start', payload: '<payload>' }`.
    if (
      params.commandIntent &&
      params.commandIntent.type === 'start' &&
      typeof params.commandIntent.payload === 'string'
    ) {
      return extractTokenFromStartPayload(params.commandIntent.payload);
    }

    // Fallback: raw content parsing for `/start <payload>` messages.
    // This handles cases where the gateway forwards the raw command text
    // without a structured commandIntent.
    const match = params.content.match(/^\/start\s+(\S+)/i);
    if (match && match[1] && match[1].length > 0) {
      return extractTokenFromStartPayload(match[1]);
    }

    return undefined;
  },
};

// ---------------------------------------------------------------------------
// Auto-register on import
// ---------------------------------------------------------------------------

registerTransport(telegramInviteTransport);
