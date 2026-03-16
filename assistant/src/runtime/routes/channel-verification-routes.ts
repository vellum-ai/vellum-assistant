/**
 * Route handlers for channel verification session endpoints.
 *
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
 * Body: { channel?: ChannelId; destination?: string; rebind?: boolean; conversationId?: string; originConversationId?: string; purpose?: string; contactChannelId?: string }
 */
export async function handleCreateVerificationSession(
  req: Request,
  assistantId: string,
): Promise<Response> {
  const body = (await req.json()) as {
    channel?: ChannelId;
    destination?: string;
    rebind?: boolean;
    conversationId?: string;
    originConversationId?: string;
    purpose?: string;
    contactChannelId?: string;
  };

  const purpose = body.purpose ?? "guardian";

  if (purpose === "trusted_contact" && !body.contactChannelId) {
    return httpError(
      "BAD_REQUEST",
      "contactChannelId is required for trusted_contact purpose",
      400,
    );
  }

  // Trusted contact verification path — delegates to the shared transport-agnostic
  // function and wraps the result in an HTTP response.
  if (purpose === "trusted_contact") {
    const result = await verifyTrustedContact(
      body.contactChannelId!,
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
    body.conversationId,
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

export function channelVerificationRouteDefinitions(): RouteDefinition[] {
  return [
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
