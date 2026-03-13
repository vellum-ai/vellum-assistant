/**
 * Telegram channel invite adapter.
 *
 * Builds `https://t.me/<botUsername>?start=iv_<token>` deep links,
 * extracts invite tokens from `/start iv_<token>` command payloads,
 * and resolves the bot's channel handle for invite instructions.
 *
 * The `iv_` prefix distinguishes invite tokens from `gv_` (guardian
 * verification) tokens that use the same `/start` deep-link mechanism.
 */

import type { ChannelId } from "../../channels/types.js";
import {
  invalidateConfigCache,
  loadRawConfig,
  saveRawConfig,
  setNestedValue,
} from "../../config/loader.js";
import { credentialKey } from "../../security/credential-key.js";
import { getSecureKeyAsync } from "../../security/secure-keys.js";
import { getTelegramBotUsername } from "../../telegram/bot-username.js";
import { getLogger } from "../../util/logger.js";
import type {
  ChannelInviteAdapter,
  InviteShareLink,
} from "../channel-invite-transport.js";

// ---------------------------------------------------------------------------
// Bot username resolution
// ---------------------------------------------------------------------------

/**
 * Ensure the Telegram bot username is resolved and cached in config.
 * When the bot token was configured via CLI `credential set`,
 * `credential_store` tool, or ingress secret redirect, the `getMe` API
 * call that populates the config is skipped — this function fills that
 * gap so that invite share links can be generated.
 */
export async function ensureTelegramBotUsernameResolved(): Promise<void> {
  if (getTelegramBotUsername()) {
    return; // Username already cached in config
  }

  const token = await getSecureKeyAsync(credentialKey("telegram", "bot_token"));
  if (!token) return;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    let res: Response;
    try {
      res = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!res.ok) {
      getLogger("telegram-invite").warn(
        "Failed to resolve Telegram bot username: HTTP %d",
        res.status,
      );
      return;
    }
    const body = (await res.json()) as {
      ok: boolean;
      result?: { username?: string };
    };
    const username = body.result?.username;
    if (!username) {
      getLogger("telegram-invite").warn(
        "Telegram getMe response did not include a username",
      );
      return;
    }
    // Write to config
    const raw = loadRawConfig();
    setNestedValue(raw, "telegram.botUsername", username);
    saveRawConfig(raw);
    invalidateConfigCache();
  } catch (err) {
    getLogger("telegram-invite").warn(
      { err },
      "Failed to resolve Telegram bot username via getMe API",
    );
  }
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

  resolveChannelHandle(): string | undefined {
    const botUsername = getTelegramBotUsername();
    if (!botUsername) return undefined;
    return `@${botUsername}`;
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
