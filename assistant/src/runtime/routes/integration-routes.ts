/**
 * Route handlers for integration config endpoints.
 *
 * Telegram:
 * GET    /v1/integrations/telegram/config   — get current config status
 * POST   /v1/integrations/telegram/config   — set bot token and configure webhook
 * DELETE /v1/integrations/telegram/config   — clear credentials and deregister webhook
 * POST   /v1/integrations/telegram/commands — register bot commands
 * POST   /v1/integrations/telegram/setup    — composite: set config + register commands
 *
 * Guardian verification:
 * POST   /v1/integrations/guardian/challenge — create a verification challenge
 * GET    /v1/integrations/guardian/status    — check guardian binding status
 */

import type { ChannelId } from '../../channels/types.js';
import {
  createGuardianChallenge,
  getGuardianStatus,
} from '../../daemon/handlers/config-channels.js';
import {
  clearTelegramConfig,
  getTelegramConfig,
  setTelegramCommands,
  setTelegramConfig,
  setupTelegram,
} from '../../daemon/handlers/config-telegram.js';

/**
 * GET /v1/integrations/telegram/config
 */
export function handleGetTelegramConfig(): Response {
  const result = getTelegramConfig();
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
export async function handleSetTelegramCommands(req: Request): Promise<Response> {
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
// Guardian verification
// ---------------------------------------------------------------------------

/**
 * POST /v1/integrations/guardian/challenge
 *
 * Body: { channel?: ChannelId; assistantId?: string; rebind?: boolean; sessionId?: string }
 */
export async function handleCreateGuardianChallenge(req: Request): Promise<Response> {
  const body = (await req.json()) as {
    channel?: ChannelId;
    assistantId?: string;
    rebind?: boolean;
    sessionId?: string;
  };
  const result = createGuardianChallenge(body.channel, body.assistantId, body.rebind, body.sessionId);
  const status = result.success ? 200 : 400;
  return Response.json(result, { status });
}

/**
 * GET /v1/integrations/guardian/status
 *
 * Query params: channel?, assistantId?
 */
export function handleGetGuardianStatus(url: URL): Response {
  const channel = (url.searchParams.get('channel') as ChannelId | null) ?? undefined;
  const assistantId = url.searchParams.get('assistantId') ?? undefined;
  const result = getGuardianStatus(channel, assistantId);
  return Response.json(result);
}
