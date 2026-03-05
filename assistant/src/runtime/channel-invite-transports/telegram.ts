/**
 * Telegram channel invite adapter.
 *
 * Builds `https://t.me/<botUsername>?start=iv_<token>` deep links and
 * extracts invite tokens from `/start iv_<token>` command payloads.
 *
 * The `iv_` prefix distinguishes invite tokens from `gv_` (guardian
 * verification) tokens that use the same `/start` deep-link mechanism.
 */

import type { ChannelId } from "../../channels/types.js";
import { getCredentialMetadata } from "../../tools/credentials/metadata-store.js";
import type {
  ChannelInviteAdapter,
  GuardianInstruction,
  InviteShareLink,
} from "../channel-invite-transport.js";

// ---------------------------------------------------------------------------
// Bot username resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the Telegram bot username from credential metadata, falling back
 * to the TELEGRAM_BOT_USERNAME environment variable. Mirrors the resolution
 * strategy used in `guardian-outbound-actions.ts`.
 */
function getTelegramBotUsername(): string | undefined {
  const meta = getCredentialMetadata("telegram", "bot_token");
  if (
    meta?.accountInfo &&
    typeof meta.accountInfo === "string" &&
    meta.accountInfo.trim().length > 0
  ) {
    return meta.accountInfo.trim();
  }
  return process.env.TELEGRAM_BOT_USERNAME || undefined;
}

// ---------------------------------------------------------------------------
// Token prefix
// ---------------------------------------------------------------------------

const INVITE_TOKEN_PREFIX = "iv_";

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

export const telegramInviteAdapter: ChannelInviteAdapter = {
  channel: "telegram" as ChannelId,

  buildShareLink(params: {
    rawToken: string;
    sourceChannel: ChannelId;
  }): InviteShareLink {
    const botUsername = getTelegramBotUsername();
    if (!botUsername) {
      throw new Error(
        "Telegram bot username is not configured. Set up the Telegram integration first.",
      );
    }

    const url = `https://t.me/${botUsername}?start=${INVITE_TOKEN_PREFIX}${params.rawToken}`;
    return {
      url,
      displayText: `Open in Telegram: ${url}`,
    };
  },

  buildGuardianInstruction(params: {
    inviteCode: string;
    contactName?: string;
  }): GuardianInstruction {
    const botUsername = getTelegramBotUsername();
    const contactLabel = params.contactName || "the contact";
    if (!botUsername) {
      return {
        instruction: `Tell ${contactLabel} to message the assistant on Telegram and provide the code ${params.inviteCode}.`,
      };
    }
    return {
      instruction: `Tell ${contactLabel} to message @${botUsername} on Telegram and provide the code ${params.inviteCode}.`,
      channelHandle: `@${botUsername}`,
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
      params.commandIntent.type === "start" &&
      typeof params.commandIntent.payload === "string"
    ) {
      const payload = params.commandIntent.payload;
      if (payload.startsWith(INVITE_TOKEN_PREFIX)) {
        const token = payload.slice(INVITE_TOKEN_PREFIX.length);
        // Reject empty or whitespace-only tokens
        if (token.length > 0 && token.trim().length > 0) {
          return token;
        }
      }
      return undefined;
    }

    // Fallback: raw content parsing for `/start iv_<token>` messages.
    // This handles cases where the gateway forwards the raw command text
    // without a structured commandIntent.
    const match = params.content.match(/^\/start\s+iv_(\S+)/);
    if (match && match[1] && match[1].length > 0) {
      return match[1];
    }

    return undefined;
  },
};

// ---------------------------------------------------------------------------
// Backward-compatible alias
// ---------------------------------------------------------------------------

/** @deprecated Use `telegramInviteAdapter` instead. */
export const telegramInviteTransport = telegramInviteAdapter;
