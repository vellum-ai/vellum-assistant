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
 * Slack channel:
 * GET    /v1/integrations/slack/channel/config — get current config status
 * POST   /v1/integrations/slack/channel/config — validate and store credentials
 * DELETE /v1/integrations/slack/channel/config — clear credentials
 *
 * Guardian verification:
 * POST   /v1/integrations/guardian/challenge        — create a verification challenge
 * GET    /v1/integrations/guardian/status            — check guardian binding status
 * POST   /v1/integrations/guardian/revoke            — revoke active guardian binding
 * POST   /v1/integrations/guardian/outbound/start    — start outbound verification
 * POST   /v1/integrations/guardian/outbound/resend   — resend outbound verification
 * POST   /v1/integrations/guardian/outbound/cancel   — cancel outbound verification
 */

import type { ChannelId } from "../../channels/types.js";
import {
  createGuardianChallenge,
  getGuardianStatus,
  revokeGuardianForChannel,
} from "../../daemon/handlers/config-channels.js";
import {
  clearSlackChannelConfig,
  getSlackChannelConfig,
  setSlackChannelConfig,
} from "../../daemon/handlers/config-slack-channel.js";
import {
  clearTelegramConfig,
  getTelegramConfig,
  setTelegramCommands,
  setTelegramConfig,
  setupTelegram,
} from "../../daemon/handlers/config-telegram.js";
import { normalizePhoneNumber } from "../../util/phone.js";
import {
  cancelOutbound,
  normalizeTelegramDestination,
  resendOutbound,
  startOutbound,
} from "../guardian-outbound-actions.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";
import { guardianVerificationLimiter } from "../verification-rate-limiter.js";

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
// Slack channel config
// ---------------------------------------------------------------------------

/**
 * GET /v1/integrations/slack/channel/config
 */
export function handleGetSlackChannelConfig(): Response {
  const result = getSlackChannelConfig();
  return Response.json(result);
}

/**
 * POST /v1/integrations/slack/channel/config
 *
 * Body: { botToken?: string, appToken?: string }
 */
export async function handleSetSlackChannelConfig(
  req: Request,
): Promise<Response> {
  const body = (await req.json()) as { botToken?: string; appToken?: string };
  const result = await setSlackChannelConfig(body.botToken, body.appToken);
  const status = result.success ? 200 : 400;
  return Response.json(result, { status });
}

/**
 * DELETE /v1/integrations/slack/channel/config
 */
export function handleClearSlackChannelConfig(): Response {
  const result = clearSlackChannelConfig();
  return Response.json(result);
}

// ---------------------------------------------------------------------------
// Guardian verification
// ---------------------------------------------------------------------------

/**
 * POST /v1/integrations/guardian/challenge
 *
 * Body: { channel?: ChannelId; rebind?: boolean; sessionId?: string }
 */
export async function handleCreateGuardianChallenge(
  req: Request,
): Promise<Response> {
  const body = (await req.json()) as {
    channel?: ChannelId;
    rebind?: boolean;
    sessionId?: string;
  };
  const result = createGuardianChallenge(
    body.channel,
    body.rebind,
    body.sessionId,
  );
  const status = result.success ? 200 : 400;
  return Response.json(result, { status });
}

/**
 * GET /v1/integrations/guardian/status
 *
 * Query params: channel?
 */
export function handleGetGuardianStatus(url: URL): Response {
  const channel =
    (url.searchParams.get("channel") as ChannelId | null) ?? undefined;
  const result = getGuardianStatus(channel);
  return Response.json(result);
}

/**
 * POST /v1/integrations/guardian/revoke
 *
 * Body: { channel?: ChannelId }
 */
export async function handleRevokeGuardian(req: Request): Promise<Response> {
  const body = (await req.json()) as {
    channel?: ChannelId;
  };
  const result = revokeGuardianForChannel(body.channel);
  const status = result.success ? 200 : 400;
  return Response.json(result, { status });
}

// ---------------------------------------------------------------------------
// Guardian outbound verification
// ---------------------------------------------------------------------------

/**
 * POST /v1/integrations/guardian/outbound/start
 *
 * Body: { channel: ChannelId; destination?: string; rebind?: boolean; originConversationId?: string }
 */
export async function handleStartOutbound(req: Request): Promise<Response> {
  const body = (await req.json()) as {
    channel?: ChannelId;
    destination?: string;
    rebind?: boolean;
    originConversationId?: string;
  };
  if (!body.channel) {
    return httpError("BAD_REQUEST", 'The "channel" field is required.', 400);
  }

  // Normalize destination to prevent rate-limit bypass via format variations
  // (e.g. "+15551234567" vs "(555) 123-4567", or "@User" vs "user")
  let rateLimitKey = body.destination;
  if (rateLimitKey) {
    if (body.channel === "sms" || body.channel === "voice") {
      rateLimitKey = normalizePhoneNumber(rateLimitKey) ?? rateLimitKey;
    } else if (body.channel === "telegram") {
      rateLimitKey = normalizeTelegramDestination(rateLimitKey);
    }
  }

  if (rateLimitKey && guardianVerificationLimiter.isBlocked(rateLimitKey)) {
    return httpError(
      "RATE_LIMITED",
      "Too many verification attempts for this identity. Please try again later.",
      429,
    );
  }

  const result = await startOutbound({
    channel: body.channel,
    destination: body.destination,
    rebind: body.rebind,
    originConversationId: body.originConversationId,
  });

  if (!result.success && rateLimitKey) {
    guardianVerificationLimiter.recordFailure(rateLimitKey);
  }

  const status = result.success
    ? 200
    : result.error === "rate_limited"
      ? 429
      : 400;
  return Response.json(result, { status });
}

/**
 * POST /v1/integrations/guardian/outbound/resend
 *
 * Body: { channel: ChannelId; originConversationId?: string }
 */
export async function handleResendOutbound(req: Request): Promise<Response> {
  const body = (await req.json()) as {
    channel?: ChannelId;
    originConversationId?: string;
  };
  if (!body.channel) {
    return httpError("BAD_REQUEST", 'The "channel" field is required.', 400);
  }
  const result = resendOutbound({
    channel: body.channel,
    originConversationId: body.originConversationId,
  });
  const status = result.success
    ? 200
    : result.error === "rate_limited"
      ? 429
      : 400;
  return Response.json(result, { status });
}

/**
 * POST /v1/integrations/guardian/outbound/cancel
 *
 * Body: { channel: ChannelId }
 */
export async function handleCancelOutbound(req: Request): Promise<Response> {
  const body = (await req.json()) as {
    channel?: ChannelId;
  };
  if (!body.channel) {
    return httpError("BAD_REQUEST", 'The "channel" field is required.', 400);
  }
  const result = cancelOutbound({
    channel: body.channel,
  });
  const status = result.success ? 200 : 400;
  return Response.json(result, { status });
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function integrationRouteDefinitions(): RouteDefinition[] {
  return [
    // Telegram
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
    // Slack
    {
      endpoint: "integrations/slack/channel/config",
      method: "GET",
      handler: () => handleGetSlackChannelConfig(),
    },
    {
      endpoint: "integrations/slack/channel/config",
      method: "POST",
      handler: async ({ req }) => handleSetSlackChannelConfig(req),
    },
    {
      endpoint: "integrations/slack/channel/config",
      method: "DELETE",
      handler: () => handleClearSlackChannelConfig(),
    },
    // Guardian
    {
      endpoint: "integrations/guardian/challenge",
      method: "POST",
      handler: async ({ req }) => handleCreateGuardianChallenge(req),
    },
    {
      endpoint: "integrations/guardian/status",
      method: "GET",
      handler: ({ url }) => handleGetGuardianStatus(url),
    },
    {
      endpoint: "integrations/guardian/revoke",
      method: "POST",
      handler: async ({ req }) => handleRevokeGuardian(req),
    },
    {
      endpoint: "integrations/guardian/outbound/start",
      method: "POST",
      handler: async ({ req }) => handleStartOutbound(req),
    },
    {
      endpoint: "integrations/guardian/outbound/resend",
      method: "POST",
      handler: async ({ req }) => handleResendOutbound(req),
    },
    {
      endpoint: "integrations/guardian/outbound/cancel",
      method: "POST",
      handler: async ({ req }) => handleCancelOutbound(req),
    },
  ];
}
