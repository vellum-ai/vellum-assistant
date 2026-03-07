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
 * Channel verification (unified session API):
 * POST   /v1/channel-verification-sessions        — create session (inbound challenge, outbound verification, or trusted contact)
 * POST   /v1/channel-verification-sessions/resend  — resend outbound verification code
 * DELETE /v1/channel-verification-sessions         — cancel all active sessions (inbound + outbound)
 * POST   /v1/channel-verification-sessions/revoke  — cancel all sessions and revoke binding
 * GET    /v1/channel-verification-sessions/status   — check guardian binding status
 */

import type { ChannelId } from "../../channels/types.js";
import {
  createInboundChallenge,
  getVerificationStatus,
  revokeVerificationForChannel,
  verifyTrustedContact,
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
import { revokePendingSessions } from "../channel-verification-service.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";
import {
  cancelOutbound,
  normalizeTelegramDestination,
  resendOutbound,
  startOutbound,
} from "../verification-outbound-actions.js";
import { verificationRateLimiter } from "../verification-rate-limiter.js";

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
export async function handleClearSlackChannelConfig(): Promise<Response> {
  const result = await clearSlackChannelConfig();
  return Response.json(result);
}

// ---------------------------------------------------------------------------
// Channel verification (unified session API)
// ---------------------------------------------------------------------------

/**
 * POST /v1/channel-verification-sessions
 *
 * Unified session creation:
 * - `purpose: "trusted_contact"` with `contactChannelId`: trusted contact verification
 * - `destination` present: outbound guardian verification
 * - Otherwise: inbound guardian challenge
 *
 * Body: { channel?: ChannelId; destination?: string; rebind?: boolean; sessionId?: string; originConversationId?: string; purpose?: string; contactChannelId?: string }
 */
export async function handleCreateVerificationSession(
  req: Request,
  assistantId: string,
): Promise<Response> {
  const body = (await req.json()) as {
    channel?: ChannelId;
    destination?: string;
    rebind?: boolean;
    sessionId?: string;
    originConversationId?: string;
    purpose?: string;
    contactChannelId?: string;
  };

  const purpose = body.purpose ?? "guardian";

  // Trusted contact verification path — delegates to the shared transport-agnostic
  // function and wraps the result in an HTTP response.
  if (purpose === "trusted_contact" && body.contactChannelId) {
    const result = await verifyTrustedContact(
      body.contactChannelId,
      assistantId,
    );
    const status = result.success
      ? 200
      : result.error === "rate_limited"
        ? 429
        : result.error === "already_verified"
          ? 409
          : 400;
    return Response.json(result, { status });
  }

  if (body.destination) {
    // Outbound verification path — requires a channel
    if (!body.channel) {
      return httpError("BAD_REQUEST", 'The "channel" field is required.', 400);
    }

    // Normalize destination to prevent rate-limit bypass via format variations
    // (e.g. "+15551234567" vs "(555) 123-4567", or "@User" vs "user")
    let rateLimitKey: string | undefined = body.destination;
    if (rateLimitKey) {
      if (body.channel === "phone") {
        rateLimitKey = normalizePhoneNumber(rateLimitKey) ?? rateLimitKey;
      } else if (body.channel === "telegram") {
        rateLimitKey = normalizeTelegramDestination(rateLimitKey);
      }
    }

    if (rateLimitKey && verificationRateLimiter.isBlocked(rateLimitKey)) {
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
      verificationRateLimiter.recordFailure(rateLimitKey);
    }

    const status = result.success
      ? 200
      : result.error === "rate_limited"
        ? 429
        : 400;
    return Response.json(result, { status });
  }

  // Inbound challenge path
  const result = createInboundChallenge(
    body.channel,
    body.rebind,
    body.sessionId,
  );
  const status = result.success ? 200 : 400;
  return Response.json(result, { status });
}

/**
 * GET /v1/channel-verification-sessions/status
 *
 * Query params: channel?
 */
export function handleGetVerificationStatus(url: URL): Response {
  const channel =
    (url.searchParams.get("channel") as ChannelId | null) ?? undefined;
  const result = getVerificationStatus(channel);
  return Response.json(result);
}

/**
 * POST /v1/channel-verification-sessions/resend
 *
 * Body: { channel: ChannelId; originConversationId?: string }
 */
export async function handleResendVerificationSession(
  req: Request,
): Promise<Response> {
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
 * DELETE /v1/channel-verification-sessions
 *
 * Cancels both inbound challenges and outbound sessions.
 *
 * Body: { channel: ChannelId }
 */
export async function handleCancelVerificationSession(
  req: Request,
): Promise<Response> {
  const body = (await req.json()) as {
    channel?: ChannelId;
  };
  if (!body.channel) {
    return httpError("BAD_REQUEST", 'The "channel" field is required.', 400);
  }

  // Cancel any active outbound session
  cancelOutbound({ channel: body.channel });
  // Cancel any pending inbound challenge
  revokePendingSessions(body.channel);

  return Response.json({ success: true, channel: body.channel });
}

/**
 * POST /v1/channel-verification-sessions/revoke
 *
 * Cancels all active sessions and revokes the guardian binding.
 *
 * Body: { channel?: ChannelId }
 */
export async function handleRevokeVerificationBinding(
  req: Request,
): Promise<Response> {
  const body = (await req.json()) as {
    channel?: ChannelId;
  };

  // revokeVerificationForChannel already handles cancelOutbound + revokePendingSessions + binding revocation
  const result = revokeVerificationForChannel(body.channel);
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
    // Channel verification (unified session API)
    {
      endpoint: "channel-verification-sessions",
      method: "POST",
      handler: async ({ req, authContext }) =>
        handleCreateVerificationSession(req, authContext.assistantId),
    },
    {
      endpoint: "channel-verification-sessions/resend",
      method: "POST",
      handler: async ({ req }) => handleResendVerificationSession(req),
    },
    {
      endpoint: "channel-verification-sessions",
      method: "DELETE",
      handler: async ({ req }) => handleCancelVerificationSession(req),
    },
    {
      endpoint: "channel-verification-sessions/revoke",
      method: "POST",
      handler: async ({ req }) => handleRevokeVerificationBinding(req),
    },
    {
      endpoint: "channel-verification-sessions/status",
      method: "GET",
      handler: ({ url }) => handleGetVerificationStatus(url),
    },
  ];
}
