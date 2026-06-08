/**
 * Route handlers for Telegram integration config endpoints.
 *
 * GET    /v1/integrations/telegram/config   — get current config status
 * POST   /v1/integrations/telegram/config   — set bot token and configure webhook
 * DELETE /v1/integrations/telegram/config   — clear credentials and deregister webhook
 * POST   /v1/integrations/telegram/commands — register bot commands
 * POST   /v1/integrations/telegram/setup    — composite: set config + register commands
 */

import { z } from "zod";

import {
  clearTelegramConfig,
  getTelegramConfig,
  setTelegramCommands,
  setTelegramConfig,
  setupTelegram,
  TelegramConfigResultSchema,
} from "../../../daemon/handlers/config-telegram.js";
import { ACTOR_PRINCIPALS } from "../../auth/route-policy.js";
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
      (result as { error?: string }).error ?? "Failed to set Telegram config",
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
      (result as { error?: string }).error ?? "Failed to set Telegram commands",
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
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get Telegram config",
    description: "Check current Telegram bot configuration status.",
    tags: ["integrations"],
    responseBody: TelegramConfigResultSchema,
    handler: () => handleGetTelegramConfig(),
  },
  {
    operationId: "integrations_telegram_config_post",
    endpoint: "integrations/telegram/config",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Set Telegram config",
    description: "Set bot token and configure webhook.",
    tags: ["integrations"],
    handler: handleSetTelegramConfig,
    requestBody: z.object({
      botToken: z.string().describe("Telegram bot token"),
    }),
    responseBody: TelegramConfigResultSchema,
  },
  {
    operationId: "integrations_telegram_config_delete",
    endpoint: "integrations/telegram/config",
    method: "DELETE",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Clear Telegram config",
    description: "Clear credentials and deregister webhook.",
    tags: ["integrations"],
    responseBody: TelegramConfigResultSchema,
    handler: () => handleClearTelegramConfig(),
  },
  {
    operationId: "integrations_telegram_commands_post",
    endpoint: "integrations/telegram/commands",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Register Telegram commands",
    description: "Register bot commands with the Telegram API.",
    tags: ["integrations"],
    responseBody: TelegramConfigResultSchema,
    handler: handleSetTelegramCommands,
  },
  {
    operationId: "integrations_telegram_setup_post",
    endpoint: "integrations/telegram/setup",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Setup Telegram",
    description: "Composite: set config + register commands.",
    tags: ["integrations"],
    responseBody: TelegramConfigResultSchema,
    handler: handleSetupTelegram,
  },
];
