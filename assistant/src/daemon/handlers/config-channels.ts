import { createHash, randomBytes } from "node:crypto";

import { startVerificationCall } from "../../calls/call-domain.js";
import type { ChannelId } from "../../channels/types.js";
import {
  findContactChannel,
  findGuardianForChannel,
  getChannelById,
  getContact,
} from "../../contacts/contact-store.js";
import { revokeMember } from "../../contacts/contacts-write.js";
import type { ChannelStatus } from "../../contacts/types.js";
import * as externalConversationStore from "../../memory/external-conversation-store.js";
import { resolveGuardianName } from "../../prompts/user-reference.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../../runtime/assistant-scope.js";
import {
  type ChannelReadinessService,
  createReadinessService,
} from "../../runtime/channel-readiness-service.js";
import {
  countRecentSendsToDestination,
  createInboundVerificationSession,
  createOutboundSession,
  findActiveSession,
  getGuardianBinding,
  getPendingSession,
  revokeBinding,
  revokePendingSessions,
  updateSessionDelivery,
} from "../../runtime/channel-verification-service.js";
import {
  cancelOutbound,
  deliverVerificationSlack,
  deliverVerificationTelegram,
  DESTINATION_RATE_WINDOW_MS,
  MAX_SENDS_PER_DESTINATION_WINDOW,
  normalizeTelegramDestination,
  resendOutbound,
  startOutbound,
} from "../../runtime/verification-outbound-actions.js";
import {
  composeVerificationSlack,
  composeVerificationTelegram,
  GUARDIAN_VERIFY_TEMPLATE_KEYS,
} from "../../runtime/verification-templates.js";
import { getTelegramBotUsername } from "../../telegram/bot-username.js";
import { normalizePhoneNumber } from "../../util/phone.js";
import type {
  ChannelVerificationSessionRequest,
  ChannelVerificationSessionResponse,
} from "../message-protocol.js";
import { type HandlerContext, log } from "./shared.js";

// -- Transport-agnostic result type (omits the `type` discriminant) --

export type ChannelVerificationSessionResult = Omit<
  ChannelVerificationSessionResponse,
  "type"
>;

// ---------------------------------------------------------------------------
// Readiness service singleton
// ---------------------------------------------------------------------------

// Lazy singleton — created on first use so module-load stays lightweight.
let _readinessService: ChannelReadinessService | undefined;
export function getReadinessService(): ChannelReadinessService {
  if (!_readinessService) {
    _readinessService = createReadinessService();
  }
  return _readinessService;
}

// ---------------------------------------------------------------------------
// Extracted business logic functions
// ---------------------------------------------------------------------------

export function createInboundChallenge(
  channel?: ChannelId,
  rebind?: boolean,
  sessionId?: string,
): ChannelVerificationSessionResult {
  const resolvedAssistantId = DAEMON_INTERNAL_ASSISTANT_ID;
  const resolvedChannel = channel ?? "telegram";

  const existingBinding = getGuardianBinding(
    resolvedAssistantId,
    resolvedChannel,
  );
  if (existingBinding && !rebind) {
    return {
      success: false,
      error: "already_bound",
      message:
        "A guardian is already bound for this channel. Revoke the existing binding first, or set rebind: true to replace.",
      channel: resolvedChannel,
    };
  }

  const result = createInboundVerificationSession(resolvedChannel, sessionId);

  return {
    success: true,
    secret: result.secret,
    instruction: result.instruction,
    channel: resolvedChannel,
  };
}

export function getVerificationStatus(
  channel?: ChannelId,
): ChannelVerificationSessionResult {
  const resolvedAssistantId = DAEMON_INTERNAL_ASSISTANT_ID;
  const resolvedChannel = channel ?? "telegram";

  const binding = getGuardianBinding(resolvedAssistantId, resolvedChannel);

  // Read the contact directly to get displayName — getGuardianBinding is a
  // compatibility shim that doesn't carry metadataJson.
  const guardianResult = findGuardianForChannel(resolvedChannel);
  const bindingDisplayName = guardianResult?.contact.displayName;
  const guardianDisplayName = resolveGuardianName(bindingDisplayName);

  // Resolve username from external conversation store.
  let guardianUsername: string | undefined;
  if (binding?.guardianDeliveryChatId) {
    const ext = externalConversationStore.getBindingByChannelChat(
      resolvedChannel,
      binding.guardianDeliveryChatId,
    );
    if (ext?.username) {
      guardianUsername = ext.username;
    }
  }
  const hasPendingChallenge = getPendingSession(resolvedChannel) != null;

  // Include active outbound session state so the UI can resume
  // after app restart and detect bootstrap completion.
  const activeOutboundSession = findActiveSession(resolvedChannel);
  const outboundFields: Record<string, unknown> = {};
  if (activeOutboundSession) {
    outboundFields.verificationSessionId = activeOutboundSession.id;
    outboundFields.expiresAt = activeOutboundSession.expiresAt;
    outboundFields.nextResendAt = activeOutboundSession.nextResendAt;
    outboundFields.sendCount = activeOutboundSession.sendCount;
    if (activeOutboundSession.status === "pending_bootstrap") {
      outboundFields.pendingBootstrap = true;
    }
  }

  return {
    success: true,
    bound: binding != null,
    guardianExternalUserId: binding?.guardianExternalUserId,
    guardianUsername,
    guardianDisplayName,
    channel: resolvedChannel,
    assistantId: resolvedAssistantId,
    guardianDeliveryChatId: binding?.guardianDeliveryChatId,
    hasPendingChallenge,
    ...outboundFields,
  };
}

// ---------------------------------------------------------------------------
// Revoke verification binding
// ---------------------------------------------------------------------------

export function revokeVerificationForChannel(
  channel?: ChannelId,
): ChannelVerificationSessionResult {
  const assistantId = DAEMON_INTERNAL_ASSISTANT_ID;
  const resolvedChannel = channel ?? "telegram";

  // Cancel any active outbound session so revoke is a complete teardown.
  cancelOutbound({ channel: resolvedChannel });

  // Always revoke pending challenges first — the macOS app uses
  // action: "revoke" to cancel an in-flight challenge even before
  // a binding exists (e.g. during verification setup).
  revokePendingSessions(resolvedChannel);

  // Capture binding before revoking so we can revoke the guardian's
  // contact record — without this, the guardian would still pass
  // the ACL check after unbinding.
  const bindingBeforeRevoke = getGuardianBinding(assistantId, resolvedChannel);
  if (!bindingBeforeRevoke) {
    return {
      success: true,
      bound: false,
      channel: resolvedChannel,
    };
  }

  // Revoke the member BEFORE the guardian binding so that
  // revokeMember sees the channel as active/pending and sets the
  // correct revokedReason ("guardian_binding_revoked"). If the guardian binding
  // is revoked first, the channel is already marked revoked and the member
  // revocation becomes a no-op (wrong reason or skipped entirely).
  const contactResult = findContactChannel({
    channelType: resolvedChannel,
    externalUserId: bindingBeforeRevoke.guardianExternalUserId,
    externalChatId: bindingBeforeRevoke.guardianDeliveryChatId,
  });

  if (contactResult) {
    const channelStatus: ChannelStatus = contactResult.channel.status;
    if (
      channelStatus === "active" ||
      channelStatus === "pending" ||
      channelStatus === "unverified"
    ) {
      revokeMember(contactResult.channel.id, "guardian_binding_revoked");
    }
  }

  revokeBinding(assistantId, resolvedChannel);

  return {
    success: true,
    bound: false,
    channel: resolvedChannel,
  };
}

// ---------------------------------------------------------------------------
// Trusted-contact verification (shared across transports)
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
      return "phone";
    case "telegram":
      return "telegram";
    case "slack":
      return "slack";
    default:
      return null;
  }
}

/**
 * Transport-agnostic trusted-contact verification. Looks up the contact
 * channel, derives the verification channel and destination, checks rate
 * limits, and creates the appropriate outbound session.
 *
 * Returns a `ChannelVerificationSessionResult` so both the message handler
 * and the HTTP handler can wrap it in their respective response envelopes.
 */
export async function verifyTrustedContact(
  contactChannelId: string,
  assistantId: string,
): Promise<ChannelVerificationSessionResult> {
  const channel = getChannelById(contactChannelId);
  if (!channel) {
    return {
      success: false,
      error: `Channel "${contactChannelId}" not found`,
    };
  }

  const contact = getContact(channel.contactId);
  if (!contact) {
    return {
      success: false,
      error: `Contact "${channel.contactId}" not found`,
    };
  }

  if (channel.status === "active" && channel.verifiedAt != null) {
    return {
      success: false,
      error: "already_verified",
      message: "Channel is already verified",
    };
  }

  const verificationChannel = toVerificationChannel(channel.type);
  if (!verificationChannel) {
    return {
      success: false,
      error: `Verification is not supported for channel type "${channel.type}"`,
    };
  }

  const destination = channel.address;
  if (!destination) {
    return {
      success: false,
      error: "Channel has no address to send verification to",
    };
  }

  const effectiveDestination =
    verificationChannel === "telegram"
      ? normalizeTelegramDestination(destination)
      : verificationChannel === "phone"
        ? (normalizePhoneNumber(destination) ?? destination)
        : destination;

  const recentSendCount = countRecentSendsToDestination(
    verificationChannel,
    effectiveDestination,
    DESTINATION_RATE_WINDOW_MS,
  );
  if (recentSendCount >= MAX_SENDS_PER_DESTINATION_WINDOW) {
    return {
      success: false,
      error: "rate_limited",
      message:
        "Too many verification attempts to this destination. Please try again later.",
    };
  }

  // --- Telegram verification ---
  if (verificationChannel === "telegram") {
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

      return {
        success: true,
        verificationSessionId: sessionResult.sessionId,
        expiresAt: sessionResult.expiresAt,
        sendCount,
        channel: verificationChannel,
      };
    }

    // Telegram handle only (no chat ID): bootstrap flow
    const { ensureTelegramBotUsernameResolved } =
      await import("../../runtime/channel-invite-transports/telegram.js");
    await ensureTelegramBotUsernameResolved();
    const botUsername = getTelegramBotUsername();
    if (!botUsername) {
      return {
        success: false,
        error:
          "Telegram bot username is not configured. Set up the Telegram integration first.",
      };
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

    return {
      success: true,
      verificationSessionId: sessionResult.sessionId,
      expiresAt: sessionResult.expiresAt,
      sendCount: 0,
      telegramBootstrapUrl,
      pendingBootstrap: true,
      channel: verificationChannel,
    };
  }

  // --- Slack verification ---
  if (verificationChannel === "slack") {
    const slackUserId = channel.externalUserId ?? destination;

    const hasIdentityBinding = Boolean(
      channel.externalUserId || channel.externalChatId,
    );
    if (!hasIdentityBinding) {
      return {
        success: false,
        error:
          "Slack verification requires an externalUserId or externalChatId for identity binding",
      };
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

    return {
      success: true,
      verificationSessionId: sessionResult.sessionId,
      expiresAt: sessionResult.expiresAt,
      sendCount,
      channel: verificationChannel,
    };
  }

  // --- Phone verification ---
  if (verificationChannel === "phone") {
    const normalizedPhone = normalizePhoneNumber(destination);
    if (!normalizedPhone) {
      return {
        success: false,
        error: "Could not parse phone number",
      };
    }

    const sessionResult = createOutboundSession({
      channel: verificationChannel,
      expectedPhoneE164: normalizedPhone,
      expectedExternalUserId: normalizedPhone,
      destinationAddress: normalizedPhone,
      codeDigits: 6,
      verificationPurpose: "trusted_contact",
    });

    const now = Date.now();
    const sendCount = 1;
    updateSessionDelivery(sessionResult.sessionId, now, sendCount, null);

    // Fire-and-forget: initiate Twilio verification call
    (async () => {
      try {
        const result = await startVerificationCall({
          phoneNumber: normalizedPhone,
          verificationSessionId: sessionResult.sessionId,
          assistantId,
        });
        if (!result.ok) {
          log.error(
            {
              error: result.error,
              status: result.status,
              phoneNumber: normalizedPhone,
              verificationSessionId: sessionResult.sessionId,
            },
            "Failed to initiate verification call for trusted contact",
          );
        }
      } catch (err) {
        log.error(
          {
            err,
            phoneNumber: normalizedPhone,
            verificationSessionId: sessionResult.sessionId,
          },
          "Failed to initiate verification call for trusted contact",
        );
      }
    })();

    return {
      success: true,
      verificationSessionId: sessionResult.sessionId,
      expiresAt: sessionResult.expiresAt,
      sendCount,
      secret: sessionResult.secret,
      channel: verificationChannel,
    };
  }

  return {
    success: false,
    error: `Verification is not supported for channel type "${channel.type}"`,
  };
}

// ---------------------------------------------------------------------------
// Channel verification session handler
// ---------------------------------------------------------------------------

export async function handleChannelVerificationSession(
  msg: ChannelVerificationSessionRequest,
  ctx: HandlerContext,
): Promise<void> {
  const channel = msg.channel ?? "telegram";

  try {
    if (msg.action === "create_session") {
      if (msg.purpose === "trusted_contact" && !msg.contactChannelId) {
        ctx.send({
          type: "channel_verification_session_response",
          success: false,
          error: "contactChannelId is required for trusted_contact purpose",
          channel,
        });
      } else if (msg.purpose === "trusted_contact") {
        const result = await verifyTrustedContact(
          msg.contactChannelId!,
          DAEMON_INTERNAL_ASSISTANT_ID,
        );
        ctx.send({
          type: "channel_verification_session_response",
          ...result,
        });
      } else if (msg.destination) {
        const result = await startOutbound({
          channel,
          destination: msg.destination,
          rebind: msg.rebind,
          originConversationId: msg.originConversationId,
        });
        ctx.send({
          type: "channel_verification_session_response",
          ...result,
        });
      } else {
        const result = createInboundChallenge(
          channel,
          msg.rebind,
          msg.conversationId,
        );
        ctx.send({
          type: "channel_verification_session_response",
          ...result,
        });
      }
    } else if (msg.action === "status") {
      const result = getVerificationStatus(channel);
      ctx.send({
        type: "channel_verification_session_response",
        ...result,
      });
    } else if (msg.action === "cancel_session") {
      cancelOutbound({ channel });
      revokePendingSessions(channel);
      ctx.send({
        type: "channel_verification_session_response",
        success: true,
        channel,
      });
    } else if (msg.action === "revoke") {
      const result = revokeVerificationForChannel(channel);
      ctx.send({
        type: "channel_verification_session_response",
        ...result,
      });
    } else if (msg.action === "resend_session") {
      const result = resendOutbound({
        channel,
        originConversationId: msg.originConversationId,
      });
      ctx.send({
        type: "channel_verification_session_response",
        ...result,
      });
    } else {
      ctx.send({
        type: "channel_verification_session_response",
        success: false,
        error: `Unknown action: ${String(msg.action)}`,
        channel,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Failed to handle channel verification session");
    ctx.send({
      type: "channel_verification_session_response",
      success: false,
      error: message,
      channel,
    });
  }
}
