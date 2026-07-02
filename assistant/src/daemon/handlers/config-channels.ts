import { createHash, randomBytes } from "node:crypto";

import type { GuardianDelivery } from "@vellumai/gateway-client";
import { MarkChannelRevokedIpcResponseSchema } from "@vellumai/gateway-client/gateway-ipc-contracts";

import { startVerificationCall } from "../../calls/call-domain.js";
import type { ChannelId } from "../../channels/types.js";
import {
  findContactChannel,
  getChannelById,
  getContact,
} from "../../contacts/contact-store.js";
import { gatewayContactChannelState } from "../../contacts/gateway-channel-read.js";
import {
  getGuardianDelivery,
  guardianForChannel,
} from "../../contacts/guardian-delivery-reader.js";
import { notifyContactsChanged } from "../../contacts/notify-contacts-changed.js";
import type { ContactChannel } from "../../contacts/types.js";
import { ipcCallPersistent } from "../../ipc/gateway-client.js";
import { getBindingByChannelChat } from "../../persistence/external-conversation-store.js";
import { resolveGuardianName } from "../../prompts/user-reference.js";
import { broadcastMessage } from "../../runtime/assistant-event-hub.js";
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
  isGuardianBoundForChannel,
  revokePendingSessions,
  updateSessionDelivery,
} from "../../runtime/channel-verification-service.js";
import {
  cancelOutbound,
  deliverVerificationEmail,
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
import { log } from "./shared.js";

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
// Gateway delivery lookup
// ---------------------------------------------------------------------------

/**
 * Resolve the gateway-owned delivery (ACL source of truth) for a contact
 * channel, matching on type and either address or externalChatId. Returns
 * `undefined` when the gateway is unreachable or has no binding for it.
 */
async function deliveryForChannel(
  channel: Pick<ContactChannel, "type" | "address" | "externalChatId">,
): Promise<GuardianDelivery | undefined> {
  const guardians = await getGuardianDelivery({ channelTypes: [channel.type] });
  if (!guardians) return undefined;
  return guardians.find(
    (g) =>
      g.channelType === channel.type &&
      ((channel.address && g.address === channel.address) ||
        (channel.externalChatId != null &&
          g.externalChatId === channel.externalChatId)),
  );
}

// ---------------------------------------------------------------------------
// Extracted business logic functions
// ---------------------------------------------------------------------------

export async function createInboundChallenge(
  channel?: ChannelId,
  rebind?: boolean,
  conversationId?: string,
): Promise<ChannelVerificationSessionResult> {
  const resolvedChannel = channel ?? "telegram";

  // Gateway-backed presence guard: block re-binding when a guardian is already
  // bound. Null-list (gateway unreachable) is treated as bound, so a transient
  // miss blocks rather than letting a second binding through.
  const alreadyBound = await isGuardianBoundForChannel(resolvedChannel);
  if (alreadyBound && !rebind) {
    return {
      success: false,
      error: "already_bound",
      message:
        "A guardian is already bound for this channel. Revoke the existing binding first, or set rebind: true to replace.",
      channel: resolvedChannel,
    };
  }

  const result = createInboundVerificationSession(
    resolvedChannel,
    conversationId,
  );

  return {
    success: true,
    secret: result.secret,
    instruction: result.instruction,
    channel: resolvedChannel,
  };
}

export async function getVerificationStatus(
  channel?: ChannelId,
): Promise<ChannelVerificationSessionResult> {
  const resolvedAssistantId = DAEMON_INTERNAL_ASSISTANT_ID;
  const resolvedChannel = channel ?? "telegram";

  const binding = await getGuardianBinding(
    resolvedAssistantId,
    resolvedChannel,
  );

  // Read the guardian displayName from the gateway delivery — getGuardianBinding
  // is a compatibility shim that doesn't carry metadataJson.
  const guardians = await getGuardianDelivery({
    channelTypes: [resolvedChannel],
  });
  const bindingDisplayName = guardians
    ? (guardianForChannel(guardians, resolvedChannel)?.displayName ?? undefined)
    : undefined;
  const guardianDisplayName = resolveGuardianName(bindingDisplayName);

  // Resolve username from external conversation store.
  let guardianUsername: string | undefined;
  if (binding?.guardianDeliveryChatId) {
    const ext = getBindingByChannelChat(
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

export async function revokeVerificationForChannel(
  channel?: ChannelId,
): Promise<ChannelVerificationSessionResult> {
  const assistantId = DAEMON_INTERNAL_ASSISTANT_ID;
  const resolvedChannel = channel ?? "telegram";

  // Session teardown stays assistant-side — it is session state, not the ACL
  // outcome. Cancel any active outbound session and pending challenges first
  // (the macOS app uses action: "revoke" to cancel an in-flight challenge even
  // before a binding exists, e.g. during verification setup).
  cancelOutbound({ channel: resolvedChannel });
  revokePendingSessions(resolvedChannel);

  // Capture binding before revoking so we can downgrade the guardian's
  // channel — without this, the guardian would still pass the ACL check.
  const bindingBeforeRevoke = await getGuardianBinding(
    assistantId,
    resolvedChannel,
  );
  if (!bindingBeforeRevoke) {
    return {
      success: true,
      bound: false,
      channel: resolvedChannel,
    };
  }

  const contactResult = findContactChannel({
    channelType: resolvedChannel,
    address: bindingBeforeRevoke.guardianExternalUserId,
    externalChatId: bindingBeforeRevoke.guardianDeliveryChatId,
  });

  // Relay the ACL downgrade to the gateway (source of truth). The gateway's
  // mark_channel_revoked enforces the guardian guard and dual-writes the
  // contact-channel status back to the assistant DB. Gate on the gateway
  // delivery's live status, not the assistant DB column, so a redundant revoke
  // is still skipped for an already-revoked binding.
  if (contactResult) {
    const delivery = await deliveryForChannel(contactResult.channel);
    const deliveryStatus = delivery?.status;
    if (
      deliveryStatus === "active" ||
      deliveryStatus === "pending" ||
      deliveryStatus === "unverified"
    ) {
      const result = await ipcCallPersistent("mark_channel_revoked", {
        contactChannelId: contactResult.channel.id,
        reason: "guardian_binding_revoked",
      });
      const parsed = MarkChannelRevokedIpcResponseSchema.parse(result);
      if (!parsed.ok) {
        throw new Error("mark_channel_revoked relay returned ok: false");
      }
      // Emit the invalidation so open client views stop showing the channel
      // as active after the gateway dual-writes it to "revoked".
      notifyContactsChanged();
    }
  }

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

  // Already-verified short-circuit derived from the gateway contact-channel read
  // (ACL SoT), which covers all contacts — not just guardian deliveries.
  const gwState = await gatewayContactChannelState(channel);
  if (gwState?.status === "active" && gwState.verifiedAt != null) {
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
        expectedExternalUserId:
          channel.address !== channel.externalChatId
            ? channel.address
            : undefined,
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
    const slackUserId = channel.address;

    const sessionResult = createOutboundSession({
      channel: verificationChannel,
      expectedExternalUserId:
        channel.address !== channel.externalChatId
          ? channel.address
          : undefined,
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
): Promise<void> {
  const channel = msg.channel ?? "telegram";

  try {
    if (msg.action === "create_session") {
      if (msg.purpose === "trusted_contact" && !msg.contactChannelId) {
        broadcastMessage({
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
        broadcastMessage({
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
        if (result._pendingSlackDm) {
          const { userId, text, assistantId: aid } = result._pendingSlackDm;
          deliverVerificationSlack(userId, text, aid);
        }
        if (result._pendingEmail) {
          const { to, text, subject, assistantId: aid } = result._pendingEmail;
          deliverVerificationEmail(to, text, subject, aid);
        }
        const {
          _pendingSlackDm: _,
          _pendingEmail: __,
          ...publicResult
        } = result;
        broadcastMessage({
          type: "channel_verification_session_response",
          ...publicResult,
        });
      } else {
        const result = await createInboundChallenge(
          channel,
          msg.rebind,
          msg.conversationId,
        );
        broadcastMessage({
          type: "channel_verification_session_response",
          ...result,
        });
      }
    } else if (msg.action === "status") {
      const result = await getVerificationStatus(channel);
      broadcastMessage({
        type: "channel_verification_session_response",
        ...result,
      });
    } else if (msg.action === "cancel_session") {
      cancelOutbound({ channel });
      revokePendingSessions(channel);
      broadcastMessage({
        type: "channel_verification_session_response",
        success: true,
        channel,
      });
    } else if (msg.action === "revoke") {
      const result = await revokeVerificationForChannel(channel);
      broadcastMessage({
        type: "channel_verification_session_response",
        ...result,
      });
    } else if (msg.action === "resend_session") {
      const result = resendOutbound({
        channel,
        originConversationId: msg.originConversationId,
      });
      if (result._pendingSlackDm) {
        const { userId, text, assistantId: aid } = result._pendingSlackDm;
        deliverVerificationSlack(userId, text, aid);
      }
      if (result._pendingEmail) {
        const { to, text, subject, assistantId: aid } = result._pendingEmail;
        deliverVerificationEmail(to, text, subject, aid);
      }
      const { _pendingSlackDm: _, _pendingEmail: __, ...publicResult } = result;
      broadcastMessage({
        type: "channel_verification_session_response",
        ...publicResult,
      });
    } else {
      broadcastMessage({
        type: "channel_verification_session_response",
        success: false,
        error: `Unknown action: ${String(msg.action)}`,
        channel,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Failed to handle channel verification session");
    broadcastMessage({
      type: "channel_verification_session_response",
      success: false,
      error: message,
      channel,
    });
  }
}
