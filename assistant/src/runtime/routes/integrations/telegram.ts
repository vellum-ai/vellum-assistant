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
import type { RouteDefinition } from "../../http-router.js";

/**
 * GET /v1/integrations/telegram/config
 */
export async function handleGetTelegramConfig(): Promise<Response> {
  const result = await getTelegramConfig();
  return Response.json(result);
}

/**
 * POST /v1/integrations/telegram/config
 *
 * Body: { botToken?: string }
 */
export async function handleSetTelegramConfig(req: Request): Promise<Response> {
  const body = (await req.json()) as { botToken?: string };
  const result = await setTelegramConfig(body.botToken);
  const status = result.success ? 200 : 400;
  return Response.json(result, { status });
}

/**
 * DELETE /v1/integrations/telegram/config
 */
export async function handleClearTelegramConfig(): Promise<Response> {
  const result = await clearTelegramConfig();
  return Response.json(result);
}

/**
 * POST /v1/integrations/telegram/commands
 *
 * Body: { commands?: Array<{ command: string; description: string }> }
 */
export async function handleSetTelegramCommands(
  req: Request,
): Promise<Response> {
  const body = (await req.json()) as {
    commands?: Array<{ command: string; description: string }>;
  };
  const result = await setTelegramCommands(body.commands);
  const status = result.success ? 200 : 400;
  return Response.json(result, { status });
}

/**
 * POST /v1/integrations/telegram/setup
 *
 * Body: { botToken?: string; commands?: Array<{ command: string; description: string }> }
 */
export async function handleSetupTelegram(req: Request): Promise<Response> {
  const body = (await req.json()) as {
    botToken?: string;
    commands?: Array<{ command: string; description: string }>;
  };
  const result = await setupTelegram(body.commands, body.botToken);
  const status = result.success ? 200 : 400;
  return Response.json(result, { status });
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function telegramRouteDefinitions(): RouteDefinition[] {
  return [
    {
      endpoint: "integrations/telegram/config",
      method: "GET",
      handler: () => handleGetTelegramConfig(),
    },
    {
      endpoint: "integrations/telegram/config",
      method: "POST",
      handler: async ({ req }) => handleSetTelegramConfig(req),
    },
    {
      endpoint: "integrations/telegram/config",
      method: "DELETE",
      handler: async () => handleClearTelegramConfig(),
    },
    {
      endpoint: "integrations/telegram/commands",
      method: "POST",
      handler: async ({ req }) => handleSetTelegramCommands(req),
    },
    {
      endpoint: "integrations/telegram/setup",
      method: "POST",
      handler: async ({ req }) => handleSetupTelegram(req),
    },
  ];
}
