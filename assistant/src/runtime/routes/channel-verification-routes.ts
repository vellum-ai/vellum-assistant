/**
 * Route handlers for channel verification session endpoints.
 *
 * POST   /v1/channel-verification-sessions        — create session (inbound challenge, outbound verification, or trusted contact)
 * POST   /v1/channel-verification-sessions/resend  — resend outbound verification code
 * DELETE /v1/channel-verification-sessions         — cancel all active sessions (inbound + outbound)
 * POST   /v1/channel-verification-sessions/revoke  — cancel all sessions and revoke binding
 * GET    /v1/channel-verification-sessions/status   — check guardian binding status
 */

import { z } from "zod";

import type { ChannelId } from "../../channels/types.js";
import {
  createInboundChallenge,
  getVerificationStatus,
  revokeVerificationForChannel,
  verifyTrustedContact,
} from "../../daemon/handlers/config-channels.js";
import { normalizePhoneNumber } from "../../util/phone.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../assistant-scope.js";
import { revokePendingSessions } from "../channel-verification-service.js";
import {
  cancelOutbound,
  deliverVerificationSlack,
  normalizeTelegramDestination,
  resendOutbound,
  startOutbound,
} from "../verification-outbound-actions.js";
import { verificationRateLimiter } from "../verification-rate-limiter.js";
import {
  BadRequestError,
  ConflictError,
  TooManyRequestsError,
} from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * POST /v1/channel-verification-sessions
 *
 * Unified session creation:
 * - `purpose: "trusted_contact"` with `contactChannelId`: trusted contact verification
 * - `destination` present: outbound guardian verification
 * - Otherwise: inbound guardian challenge
 */
export async function handleCreateVerificationSession({
  body,
}: RouteHandlerArgs) {
  if (!body || typeof body !== "object") {
    throw new BadRequestError("Request body is required");
  }

  const {
    channel,
    destination,
    rebind,
    conversationId,
    originConversationId,
    purpose: rawPurpose,
    contactChannelId,
  } = body as {
    channel?: ChannelId;
    destination?: string;
    rebind?: boolean;
    conversationId?: string;
    originConversationId?: string;
    purpose?: string;
    contactChannelId?: string;
  };

  const purpose = rawPurpose ?? "guardian";

  if (purpose === "trusted_contact" && !contactChannelId) {
    throw new BadRequestError(
      "contactChannelId is required for trusted_contact purpose",
    );
  }

  // Trusted contact verification path
  if (purpose === "trusted_contact") {
    const result = await verifyTrustedContact(
      contactChannelId!,
      DAEMON_INTERNAL_ASSISTANT_ID,
    );
    if (!result.success) {
      if (result.error === "rate_limited") {
        throw new TooManyRequestsError(
          (result as { message?: string }).message ?? "Rate limited",
        );
      }
      if (result.error === "already_verified") {
        throw new ConflictError(
          (result as { message?: string }).message ?? "Already verified",
        );
      }
      throw new BadRequestError(
        (result as { message?: string }).message ??
          "Trusted contact verification failed",
      );
    }
    return result;
  }

  if (destination) {
    // Outbound verification path — requires a channel
    if (!channel) {
      throw new BadRequestError('The "channel" field is required.');
    }

    // Normalize destination to prevent rate-limit bypass via format variations
    let rateLimitKey: string | undefined = destination;
    if (rateLimitKey) {
      if (channel === "phone") {
        rateLimitKey = normalizePhoneNumber(rateLimitKey) ?? rateLimitKey;
      } else if (channel === "telegram") {
        rateLimitKey = normalizeTelegramDestination(rateLimitKey);
      }
    }

    if (rateLimitKey && verificationRateLimiter.isBlocked(rateLimitKey)) {
      throw new TooManyRequestsError(
        "Too many verification attempts for this identity. Please try again later.",
      );
    }

    const result = await startOutbound({
      channel,
      destination,
      rebind,
      originConversationId,
    });

    if (!result.success && rateLimitKey) {
      verificationRateLimiter.recordFailure(rateLimitKey);
    }

    // Dispatch Slack DM delivery from the daemon process (not sandboxed).
    if (result._pendingSlackDm) {
      const { userId, text, assistantId: aid } = result._pendingSlackDm;
      deliverVerificationSlack(userId, text, aid);
    }

    if (!result.success) {
      if (result.error === "rate_limited") {
        throw new TooManyRequestsError(
          (result as { message?: string }).message ?? "Rate limited",
        );
      }
      throw new BadRequestError(
        (result as { message?: string }).message ??
          "Outbound verification failed",
      );
    }

    // Strip internal field from the response
    const { _pendingSlackDm: _, ...publicResult } = result;
    return publicResult;
  }

  // Inbound challenge path
  const result = createInboundChallenge(channel, rebind, conversationId);
  if (!result.success) {
    throw new BadRequestError(
      (result as { message?: string }).message ??
        "Inbound challenge creation failed",
    );
  }
  return result;
}

/**
 * GET /v1/channel-verification-sessions/status
 */
function handleGetVerificationStatus({
  queryParams = {},
}: RouteHandlerArgs) {
  const channel = (queryParams.channel as ChannelId | undefined) ?? undefined;
  return getVerificationStatus(channel);
}

/**
 * POST /v1/channel-verification-sessions/resend
 */
export async function handleResendVerificationSession({
  body,
}: RouteHandlerArgs) {
  if (!body || typeof body !== "object") {
    throw new BadRequestError("Request body is required");
  }

  const { channel, originConversationId } = body as {
    channel?: ChannelId;
    originConversationId?: string;
  };
  if (!channel) {
    throw new BadRequestError('The "channel" field is required.');
  }

  const result = resendOutbound({ channel, originConversationId });

  // Dispatch Slack DM delivery from the daemon process (not sandboxed).
  if (result._pendingSlackDm) {
    const { userId, text, assistantId: aid } = result._pendingSlackDm;
    deliverVerificationSlack(userId, text, aid);
  }

  if (!result.success) {
    if (result.error === "rate_limited") {
      throw new TooManyRequestsError(
        (result as { message?: string }).message ?? "Rate limited",
      );
    }
    throw new BadRequestError(
      (result as { message?: string }).message ?? "Resend failed",
    );
  }

  const { _pendingSlackDm: _, ...publicResult } = result;
  return publicResult;
}

/**
 * DELETE /v1/channel-verification-sessions
 */
export async function handleCancelVerificationSession({
  body,
}: RouteHandlerArgs) {
  if (!body || typeof body !== "object") {
    throw new BadRequestError("Request body is required");
  }

  const { channel } = body as { channel?: ChannelId };
  if (!channel) {
    throw new BadRequestError('The "channel" field is required.');
  }

  cancelOutbound({ channel });
  revokePendingSessions(channel);

  return { success: true, channel };
}

/**
 * POST /v1/channel-verification-sessions/revoke
 */
async function handleRevokeVerificationBinding({
  body = {},
}: RouteHandlerArgs) {
  const { channel } = body as { channel?: ChannelId };

  const result = revokeVerificationForChannel(channel);
  if (!result.success) {
    throw new BadRequestError(
      (result as { message?: string }).message ?? "Revocation failed",
    );
  }
  return result;
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "channel_verification_sessions_create",
    endpoint: "channel-verification-sessions",
    method: "POST",
    summary: "Create verification session",
    description:
      "Create a channel verification session (inbound challenge, outbound, or trusted contact).",
    tags: ["channel-verification"],
    requestBody: z.object({
      channel: z.string().describe("Channel ID"),
      destination: z.string().describe("Outbound destination"),
      rebind: z.boolean(),
      conversationId: z.string(),
      originConversationId: z.string(),
      purpose: z.string().describe("guardian or trusted_contact"),
      contactChannelId: z.string(),
    }),
    handler: handleCreateVerificationSession,
  },
  {
    operationId: "channel_verification_sessions_resend",
    endpoint: "channel-verification-sessions/resend",
    method: "POST",
    summary: "Resend verification code",
    description: "Resend the outbound verification code.",
    tags: ["channel-verification"],
    requestBody: z.object({
      channel: z.string(),
      originConversationId: z.string().optional(),
    }),
    handler: handleResendVerificationSession,
  },
  {
    operationId: "channel_verification_sessions_cancel",
    endpoint: "channel-verification-sessions",
    method: "DELETE",
    summary: "Cancel verification sessions",
    description:
      "Cancel all active inbound and outbound verification sessions.",
    tags: ["channel-verification"],
    requestBody: z.object({
      channel: z.string(),
    }),
    handler: handleCancelVerificationSession,
  },
  {
    operationId: "channel_verification_sessions_revoke",
    endpoint: "channel-verification-sessions/revoke",
    method: "POST",
    summary: "Revoke verification binding",
    description: "Cancel all sessions and revoke the guardian binding.",
    tags: ["channel-verification"],
    requestBody: z.object({
      channel: z.string(),
    }),
    handler: handleRevokeVerificationBinding,
  },
  {
    operationId: "channel_verification_sessions_status",
    endpoint: "channel-verification-sessions/status",
    method: "GET",
    summary: "Get verification status",
    description: "Check guardian binding and verification session status.",
    tags: ["channel-verification"],
    queryParams: [
      {
        name: "channel",
        schema: { type: "string" },
        description: "Optional channel ID filter",
      },
    ],
    handler: handleGetVerificationStatus,
  },
];
