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

import { createHash, randomBytes } from "node:crypto";

import type { ChannelId } from "../../channels/types.js";
import { getChannelById, getContact } from "../../contacts/contact-store.js";
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
import { getCredentialMetadata } from "../../tools/credentials/metadata-store.js";
import { normalizePhoneNumber } from "../../util/phone.js";
import {
  countRecentSendsToDestination,
  createOutboundSession,
  revokePendingSessions,
  updateSessionDelivery,
} from "../channel-verification-service.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";
import {
  cancelOutbound,
  deliverVerificationSlack,
  deliverVerificationTelegram,
  DESTINATION_RATE_WINDOW_MS,
  MAX_SENDS_PER_DESTINATION_WINDOW,
  normalizeTelegramDestination,
  resendOutbound,
  startOutbound,
} from "../verification-outbound-actions.js";
import { guardianVerificationLimiter } from "../verification-rate-limiter.js";
import {
  composeVerificationSlack,
  composeVerificationTelegram,
  GUARDIAN_VERIFY_TEMPLATE_KEYS,
} from "../verification-templates.js";

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

/** Session TTL in seconds (matches challenge TTL of 10 minutes). */
const SESSION_TTL_SECONDS = 600;

/**
 * Map a contact channel type to the verification ChannelId used by the
 * verification service. Returns null for unsupported channel types.
 */
function toVerificationChannel(channelType: string): ChannelId | null {
  switch (channelType) {
    case "phone":
      return "voice";
    case "telegram":
      return "telegram";
    case "slack":
      return "slack";
    default:
      return null;
  }
}

/**
 * Get the Telegram bot username from credential metadata.
 * Falls back to process.env.TELEGRAM_BOT_USERNAME.
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

  // Trusted contact verification path — look up the contact channel and derive
  // channel/destination from it, then create a session with verificationPurpose: "trusted_contact".
  if (purpose === "trusted_contact" && body.contactChannelId) {
    return handleTrustedContactVerification(body.contactChannelId, assistantId);
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
      if (body.channel === "voice") {
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

  // Inbound challenge path
  const result = createGuardianChallenge(
    body.channel,
    body.rebind,
    body.sessionId,
  );
  const status = result.success ? 200 : 400;
  return Response.json(result, { status });
}

/**
 * Trusted contact verification — extracted from the former
 * handleVerifyContactChannel in contact-routes.ts. Looks up the contact
 * channel, derives channelId and destination, checks rate limits, and
 * creates the session with verificationPurpose: "trusted_contact".
 */
async function handleTrustedContactVerification(
  contactChannelId: string,
  assistantId: string,
): Promise<Response> {
  const channel = getChannelById(contactChannelId);
  if (!channel) {
    return httpError(
      "NOT_FOUND",
      `Channel "${contactChannelId}" not found`,
      404,
    );
  }

  const contact = getContact(channel.contactId);
  if (!contact) {
    return httpError(
      "NOT_FOUND",
      `Contact "${channel.contactId}" not found`,
      404,
    );
  }

  // Already verified — no need to re-verify
  if (channel.status === "active" && channel.verifiedAt != null) {
    return httpError("CONFLICT", "Channel is already verified", 409);
  }

  const verificationChannel = toVerificationChannel(channel.type);
  if (!verificationChannel) {
    return httpError(
      "BAD_REQUEST",
      `Verification is not supported for channel type "${channel.type}"`,
      400,
    );
  }

  const destination = channel.address;
  if (!destination) {
    return httpError(
      "BAD_REQUEST",
      "Channel has no address to send verification to",
      400,
    );
  }

  // Normalize Telegram destinations so rate-limit lookups are consistent
  const effectiveDestination =
    verificationChannel === "telegram"
      ? normalizeTelegramDestination(destination)
      : destination;

  // Rate limit check
  const recentSendCount = countRecentSendsToDestination(
    verificationChannel,
    effectiveDestination,
    DESTINATION_RATE_WINDOW_MS,
  );
  if (recentSendCount >= MAX_SENDS_PER_DESTINATION_WINDOW) {
    return httpError(
      "RATE_LIMITED",
      "Too many verification attempts to this destination. Please try again later.",
      429,
    );
  }

  // --- Telegram verification ---
  if (verificationChannel === "telegram") {
    // Telegram with known chat ID: identity is already bound
    if (channel.externalChatId) {
      const sessionResult = createOutboundSession({
        channel: verificationChannel,
        expectedChatId: channel.externalChatId,
        expectedExternalUserId: channel.externalUserId ?? undefined,
        identityBindingStatus: "bound",
        destinationAddress: effectiveDestination,
        verificationPurpose: "trusted_contact",
      });

      const telegramBody = composeVerificationTelegram(
        GUARDIAN_VERIFY_TEMPLATE_KEYS.TELEGRAM_CHALLENGE_REQUEST,
        {
          code: sessionResult.secret,
          expiresInMinutes: Math.floor(SESSION_TTL_SECONDS / 60),
        },
      );

      const now = Date.now();
      const sendCount = 1;
      updateSessionDelivery(sessionResult.sessionId, now, sendCount, null);
      deliverVerificationTelegram(
        channel.externalChatId,
        telegramBody,
        assistantId,
      );

      return Response.json({
        ok: true,
        verificationSessionId: sessionResult.sessionId,
        expiresAt: sessionResult.expiresAt,
        sendCount,
      });
    }

    // Telegram handle only (no chat ID): bootstrap flow
    const { ensureTelegramBotUsernameResolved } =
      await import("../channel-invite-transports/telegram.js");
    await ensureTelegramBotUsernameResolved();
    const botUsername = getTelegramBotUsername();
    if (!botUsername) {
      return httpError(
        "BAD_REQUEST",
        "Telegram bot username is not configured. Set up the Telegram integration first.",
        400,
      );
    }

    const bootstrapToken = randomBytes(16).toString("hex");
    const bootstrapTokenHash = createHash("sha256")
      .update(bootstrapToken)
      .digest("hex");

    const sessionResult = createOutboundSession({
      channel: verificationChannel,
      identityBindingStatus: "pending_bootstrap",
      destinationAddress: effectiveDestination,
      bootstrapTokenHash,
      verificationPurpose: "trusted_contact",
    });

    const telegramBootstrapUrl = `https://t.me/${botUsername}?start=gv_${bootstrapToken}`;

    return Response.json({
      ok: true,
      verificationSessionId: sessionResult.sessionId,
      expiresAt: sessionResult.expiresAt,
      sendCount: 0,
      telegramBootstrapUrl,
    });
  }

  // --- Slack verification ---
  if (verificationChannel === "slack") {
    const slackUserId = channel.externalUserId ?? destination;

    // Only claim identity is bound when we have at least one platform identifier
    const hasIdentityBinding = Boolean(
      channel.externalUserId || channel.externalChatId,
    );
    if (!hasIdentityBinding) {
      return httpError(
        "BAD_REQUEST",
        "Slack verification requires an externalUserId or externalChatId for identity binding",
        400,
      );
    }

    const sessionResult = createOutboundSession({
      channel: verificationChannel,
      expectedExternalUserId: channel.externalUserId ?? undefined,
      expectedChatId: channel.externalChatId ?? undefined,
      identityBindingStatus: "bound",
      destinationAddress: slackUserId,
      verificationPurpose: "trusted_contact",
    });

    const slackBody = composeVerificationSlack(
      GUARDIAN_VERIFY_TEMPLATE_KEYS.SLACK_CHALLENGE_REQUEST,
      {
        code: sessionResult.secret,
        expiresInMinutes: Math.floor(SESSION_TTL_SECONDS / 60),
      },
    );

    const now = Date.now();
    const sendCount = 1;
    updateSessionDelivery(sessionResult.sessionId, now, sendCount, null);
    deliverVerificationSlack(slackUserId, slackBody, assistantId);

    return Response.json({
      ok: true,
      verificationSessionId: sessionResult.sessionId,
      expiresAt: sessionResult.expiresAt,
      sendCount,
    });
  }

  return httpError(
    "BAD_REQUEST",
    `Verification is not supported for channel type "${channel.type}"`,
    400,
  );
}

/**
 * GET /v1/channel-verification-sessions/status
 *
 * Query params: channel?
 */
export function handleGetVerificationStatus(url: URL): Response {
  const channel =
    (url.searchParams.get("channel") as ChannelId | null) ?? undefined;
  const result = getGuardianStatus(channel);
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

  // revokeGuardianForChannel already handles cancelOutbound + revokePendingSessions + binding revocation
  const result = revokeGuardianForChannel(body.channel);
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
