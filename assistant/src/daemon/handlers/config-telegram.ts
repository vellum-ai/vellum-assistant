import * as net from "node:net";

import {
  invalidateConfigCache,
  loadRawConfig,
  saveRawConfig,
  setNestedValue,
} from "../../config/loader.js";
import {
  registerCallbackRoute,
  shouldUsePlatformCallbacks,
} from "../../inbound/platform-callback-registration.js";
import {
  deleteSecureKeyAsync,
  getSecureKey,
  setSecureKeyAsync,
} from "../../security/secure-keys.js";
import { getTelegramBotUsername } from "../../telegram/bot-username.js";
import {
  deleteCredentialMetadata,
  upsertCredentialMetadata,
} from "../../tools/credentials/metadata-store.js";
import type {
  TelegramConfigRequest,
  TelegramConfigResponse,
} from "../ipc-protocol.js";
import { defineHandlers, type HandlerContext, log } from "./shared.js";

const TELEGRAM_BOT_TOKEN_IN_URL_PATTERN =
  /\/bot\d{8,10}:[A-Za-z0-9_-]{30,120}\//g;
const TELEGRAM_BOT_TOKEN_PATTERN =
  /(?<![A-Za-z0-9_])\d{8,10}:[A-Za-z0-9_-]{30,120}(?![A-Za-z0-9_])/g;

function redactTelegramBotTokens(value: string): string {
  return value
    .replace(TELEGRAM_BOT_TOKEN_IN_URL_PATTERN, "/bot[REDACTED]/")
    .replace(TELEGRAM_BOT_TOKEN_PATTERN, "[REDACTED]");
}

export function summarizeTelegramError(err: unknown): string {
  const parts: string[] = [];
  if (err instanceof Error) {
    parts.push(err.message);
  } else {
    parts.push(String(err));
  }
  const path = (err as { path?: unknown })?.path;
  if (typeof path === "string" && path.length > 0) {
    parts.push(`path=${path}`);
  }
  const code = (err as { code?: unknown })?.code;
  if (typeof code === "string" && code.length > 0) {
    parts.push(`code=${code}`);
  }
  return redactTelegramBotTokens(parts.join(" "));
}

// -- Transport-agnostic result type (omits the IPC `type` discriminant) --

export type TelegramConfigResult = Omit<TelegramConfigResponse, "type">;

// -- Extracted business logic functions --

export function getTelegramConfig(): TelegramConfigResult {
  const hasBotToken = !!getSecureKey("credential:telegram:bot_token");
  const hasWebhookSecret = !!getSecureKey("credential:telegram:webhook_secret");
  const botUsername = getTelegramBotUsername();
  return {
    success: true,
    hasBotToken,
    botUsername,
    connected: hasBotToken && hasWebhookSecret,
    hasWebhookSecret,
  };
}

export async function setTelegramConfig(
  botToken?: string,
): Promise<TelegramConfigResult> {
  // Resolve token: prefer explicit botToken, fall back to secure storage.
  // Track provenance so we only rollback tokens that were freshly provided.
  const isNewToken = !!botToken;
  const resolvedToken =
    botToken || getSecureKey("credential:telegram:bot_token");
  if (!resolvedToken) {
    return {
      success: false,
      hasBotToken: false,
      connected: false,
      hasWebhookSecret: false,
      error: "botToken is required for set action",
    };
  }

  // Validate token via Telegram getMe API
  let botUsername: string;
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${resolvedToken}/getMe`,
    );
    if (!res.ok) {
      const body = await res.text();
      return {
        success: false,
        hasBotToken: false,
        connected: false,
        hasWebhookSecret: false,
        error: `Telegram API validation failed: ${body}`,
      };
    }
    const data = (await res.json()) as {
      ok: boolean;
      result?: { username?: string };
    };
    if (!data.ok || !data.result?.username) {
      return {
        success: false,
        hasBotToken: false,
        connected: false,
        hasWebhookSecret: false,
        error: "Telegram API returned unexpected response",
      };
    }
    botUsername = data.result.username;
  } catch (err) {
    const message = summarizeTelegramError(err);
    return {
      success: false,
      hasBotToken: false,
      connected: false,
      hasWebhookSecret: false,
      error: `Failed to validate bot token: ${message}`,
    };
  }

  // Store bot token securely (async — writes broker + encrypted store)
  const stored = await setSecureKeyAsync(
    "credential:telegram:bot_token",
    resolvedToken,
  );
  if (!stored) {
    return {
      success: false,
      hasBotToken: false,
      connected: false,
      hasWebhookSecret: false,
      error: "Failed to store bot token in secure storage",
    };
  }

  // Store metadata with bot username (kept for consumers that haven't migrated yet)
  upsertCredentialMetadata("telegram", "bot_token", {
    accountInfo: botUsername,
  });

  // Dual-write: persist bot username to config for the new config-based path
  const raw = loadRawConfig();
  setNestedValue(raw, "telegram.botUsername", botUsername);
  saveRawConfig(raw);
  invalidateConfigCache();

  // Ensure webhook secret exists (generate if missing)
  let hasWebhookSecret = !!getSecureKey("credential:telegram:webhook_secret");
  if (!hasWebhookSecret) {
    const { randomUUID } = await import("node:crypto");
    const webhookSecret = randomUUID();
    const secretStored = await setSecureKeyAsync(
      "credential:telegram:webhook_secret",
      webhookSecret,
    );
    if (secretStored) {
      upsertCredentialMetadata("telegram", "webhook_secret", {});
      hasWebhookSecret = true;
    } else {
      // Only roll back the bot token if it was freshly provided.
      // When the token came from secure storage it was already valid
      // configuration; deleting it would destroy working state.
      if (isNewToken) {
        await deleteSecureKeyAsync("credential:telegram:bot_token");
        deleteCredentialMetadata("telegram", "bot_token");
      }
      // Always revert the config write — the botUsername was written
      // optimistically before webhook secret provisioning.
      const rawRollback = loadRawConfig();
      setNestedValue(rawRollback, "telegram.botUsername", "");
      saveRawConfig(rawRollback);
      invalidateConfigCache();
      return {
        success: false,
        hasBotToken: !isNewToken,
        connected: false,
        hasWebhookSecret: false,
        error: "Failed to store webhook secret",
      };
    }
  } else {
    // Self-heal: ensure metadata exists even when the secret was
    // already present (covers previously lost/corrupted metadata).
    upsertCredentialMetadata("telegram", "webhook_secret", {});
  }

  const result: TelegramConfigResult = {
    success: true,
    hasBotToken: true,
    botUsername,
    connected: true,
    hasWebhookSecret,
  };

  // When containerized with a platform, register the Telegram callback
  // route so the platform knows how to forward Telegram webhooks.
  // This must happen independently of effectiveUrl — in containerized
  // deployments without ingress.publicBaseUrl, platform callbacks are the
  // only way to receive Telegram webhooks.
  if (shouldUsePlatformCallbacks()) {
    registerCallbackRoute("webhooks/telegram", "telegram").catch((err) => {
      log.warn({ err }, "Failed to register Telegram platform callback route");
    });
  }

  return result;
}

export async function clearTelegramConfig(): Promise<TelegramConfigResult> {
  // Deregister the Telegram webhook before deleting credentials.
  // The gateway reconcile short-circuits when credentials are absent,
  // so we must call the Telegram API directly while the token is still
  // available.
  const botToken = getSecureKey("credential:telegram:bot_token");
  if (botToken) {
    try {
      await fetch(`https://api.telegram.org/bot${botToken}/deleteWebhook`);
    } catch (err) {
      log.warn(
        { error: summarizeTelegramError(err) },
        "Failed to deregister Telegram webhook (proceeding with credential cleanup)",
      );
    }
  }

  const r1 = await deleteSecureKeyAsync("credential:telegram:bot_token");
  const r2 = await deleteSecureKeyAsync("credential:telegram:webhook_secret");

  if (r1 === "error" || r2 === "error") {
    const hasBotToken = !!getSecureKey("credential:telegram:bot_token");
    const hasWebhookSecret = !!getSecureKey(
      "credential:telegram:webhook_secret",
    );
    return {
      success: false,
      hasBotToken,
      connected: hasBotToken && hasWebhookSecret,
      hasWebhookSecret,
      error: "Failed to delete Telegram credentials from secure storage",
    };
  }

  deleteCredentialMetadata("telegram", "bot_token");
  deleteCredentialMetadata("telegram", "webhook_secret");

  // Clear bot username from config so getTelegramBotUsername() doesn't
  // return a stale value after disconnect.
  const raw = loadRawConfig();
  setNestedValue(raw, "telegram.botUsername", "");
  saveRawConfig(raw);
  invalidateConfigCache();

  return {
    success: true,
    hasBotToken: false,
    connected: false,
    hasWebhookSecret: false,
  };
}

export async function setTelegramCommands(
  commands?: Array<{ command: string; description: string }>,
): Promise<TelegramConfigResult> {
  const storedToken = getSecureKey("credential:telegram:bot_token");
  if (!storedToken) {
    return {
      success: false,
      hasBotToken: false,
      connected: false,
      hasWebhookSecret: false,
      error: "Bot token not configured. Run set action first.",
    };
  }

  const resolvedCommands = commands ?? [
    { command: "new", description: "Start a new conversation" },
    { command: "help", description: "Show available commands" },
  ];

  try {
    const res = await fetch(
      `https://api.telegram.org/bot${storedToken}/setMyCommands`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commands: resolvedCommands }),
      },
    );
    if (!res.ok) {
      const body = await res.text();
      return {
        success: false,
        hasBotToken: true,
        connected: !!getSecureKey("credential:telegram:webhook_secret"),
        hasWebhookSecret: !!getSecureKey("credential:telegram:webhook_secret"),
        error: `Failed to set bot commands: ${body}`,
      };
    }
  } catch (err) {
    const message = summarizeTelegramError(err);
    return {
      success: false,
      hasBotToken: true,
      connected: !!getSecureKey("credential:telegram:webhook_secret"),
      hasWebhookSecret: !!getSecureKey("credential:telegram:webhook_secret"),
      error: `Failed to set bot commands: ${message}`,
    };
  }

  const hasBotToken = !!getSecureKey("credential:telegram:bot_token");
  const hasWebhookSecret = !!getSecureKey("credential:telegram:webhook_secret");
  return {
    success: true,
    hasBotToken,
    connected: hasBotToken && hasWebhookSecret,
    hasWebhookSecret,
    commandsRegistered: resolvedCommands.map((c) => c.command),
  };
}

/**
 * Composite operation: configure the bot token (set) then register commands.
 * If set succeeds but set_commands fails, returns success with a warning
 * rather than rolling back the token configuration.
 */
export async function setupTelegram(
  commands?: Array<{ command: string; description: string }>,
  botToken?: string,
): Promise<TelegramConfigResult> {
  const setResult = await setTelegramConfig(botToken);
  if (!setResult.success) {
    return setResult;
  }

  const commandsResult = await setTelegramCommands(commands);
  if (!commandsResult.success) {
    // Token was configured successfully but commands failed — return
    // the set result with a warning instead of failing entirely.
    return {
      ...setResult,
      warning: commandsResult.error ?? "Failed to register bot commands",
    };
  }

  return {
    ...commandsResult,
    botUsername: setResult.botUsername,
  };
}

// -- IPC handler (thin wrapper over extracted functions) --

export async function handleTelegramConfig(
  msg: TelegramConfigRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  try {
    let result: TelegramConfigResult;

    if (msg.action === "get") {
      result = getTelegramConfig();
    } else if (msg.action === "set") {
      result = await setTelegramConfig(msg.botToken);
    } else if (msg.action === "clear") {
      result = await clearTelegramConfig();
    } else if (msg.action === "set_commands") {
      result = await setTelegramCommands(msg.commands);
    } else if (msg.action === "setup") {
      result = await setupTelegram(msg.commands, msg.botToken);
    } else {
      result = {
        success: false,
        hasBotToken: false,
        connected: false,
        hasWebhookSecret: false,
        error: `Unknown action: ${String(msg.action)}`,
      };
    }

    ctx.send(socket, { type: "telegram_config_response", ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Failed to handle Telegram config");
    ctx.send(socket, {
      type: "telegram_config_response",
      success: false,
      hasBotToken: false,
      connected: false,
      hasWebhookSecret: false,
      error: message,
    });
  }
}

export const telegramHandlers = defineHandlers({
  telegram_config: handleTelegramConfig,
});
