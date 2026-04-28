/**
 * Route handlers for Telegram integration config endpoints.
 *
 * GET    /v1/integrations/telegram/config   — get current config status
 * POST   /v1/integrations/telegram/config   — set bot token and configure webhook
 * DELETE /v1/integrations/telegram/config   — clear credentials and deregister webhook
 * POST   /v1/integrations/telegram/commands — register bot commands
 * POST   /v1/integrations/telegram/setup    — composite: set config + register commands
 */

import {
  clearTelegramConfig,
  getTelegramConfig,
  setTelegramCommands,
  setTelegramConfig,
  setupTelegram,
} from "../../../daemon/handlers/config-telegram.js";
import { BadRequestError } from "../errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "../types.js";

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleGetTelegramConfig() {
  return getTelegramConfig();
}

async function handleSetTelegramConfig({ body = {} }: RouteHandlerArgs) {
  const { botToken } = body as { botToken?: string };
  const result = await setTelegramConfig(botToken);
  if (!result.success) {
    throw new BadRequestError(
      (result as { error?: string }).error ??
        "Failed to set Telegram config",
    );
  }
  return result;
}

async function handleClearTelegramConfig() {
  return clearTelegramConfig();
}

async function handleSetTelegramCommands({ body = {} }: RouteHandlerArgs) {
  const { commands } = body as {
    commands?: Array<{ command: string; description: string }>;
  };
  const result = await setTelegramCommands(commands);
  if (!result.success) {
    throw new BadRequestError(
      (result as { error?: string }).error ??
        "Failed to set Telegram commands",
    );
  }
  return result;
}

async function handleSetupTelegram({ body = {} }: RouteHandlerArgs) {
  const { botToken, commands } = body as {
    botToken?: string;
    commands?: Array<{ command: string; description: string }>;
  };
  const result = await setupTelegram(commands, botToken);
  if (!result.success) {
    throw new BadRequestError(
      (result as { error?: string }).error ?? "Telegram setup failed",
    );
  }
  return result;
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "integrations_telegram_config_get",
    endpoint: "integrations/telegram/config",
    method: "GET",
    summary: "Get Telegram config",
    description: "Check current Telegram bot configuration status.",
    tags: ["integrations"],
    requirePolicyEnforcement: true,
    handler: () => handleGetTelegramConfig(),
  },
  {
    operationId: "integrations_telegram_config_post",
    endpoint: "integrations/telegram/config",
    method: "POST",
    summary: "Set Telegram config",
    description: "Set bot token and configure webhook.",
    tags: ["integrations"],
    requirePolicyEnforcement: true,
    handler: handleSetTelegramConfig,
  },
  {
    operationId: "integrations_telegram_config_delete",
    endpoint: "integrations/telegram/config",
    method: "DELETE",
    summary: "Clear Telegram config",
    description: "Clear credentials and deregister webhook.",
    tags: ["integrations"],
    requirePolicyEnforcement: true,
    handler: () => handleClearTelegramConfig(),
  },
  {
    operationId: "integrations_telegram_commands_post",
    endpoint: "integrations/telegram/commands",
    method: "POST",
    summary: "Register Telegram commands",
    description: "Register bot commands with the Telegram API.",
    tags: ["integrations"],
    requirePolicyEnforcement: true,
    handler: handleSetTelegramCommands,
  },
  {
    operationId: "integrations_telegram_setup_post",
    endpoint: "integrations/telegram/setup",
    method: "POST",
    summary: "Setup Telegram",
    description: "Composite: set config + register commands.",
    tags: ["integrations"],
    requirePolicyEnforcement: true,
    handler: handleSetupTelegram,
  },
];
