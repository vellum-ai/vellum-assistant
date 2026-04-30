/**
 * Verification code intercept stage: validates and consumes verification
 * codes, applies role-specific side effects (guardian binding creation,
 * trusted-contact activation signals), upserts member records, and delivers
 * deterministic template-driven replies.
 *
 * This is the dispatch point for channel-based post-verification side
 * effects. Voice verification has its own dispatch in relay-server.ts.
 * Both guardian and trusted-contact flows converge here after
 * validateAndConsumeVerification() returns success.
 *
 * Verification code messages are short-circuited here and NEVER enter the
 * agent pipeline. This prevents verification codes from producing
 * agent-generated copy.
 */
import type { ChannelId } from "../../../channels/types.js";
import { findContactChannel } from "../../../contacts/contact-store.js";
import {
  createGuardianBinding,
  revokeGuardianBinding,
  upsertContactChannel,
} from "../../../contacts/contacts-write.js";
import {
  clearPendingVerificationReply,
  storePendingVerificationReply,
} from "../../../memory/delivery-channels.js";
import { emitNotificationSignal } from "../../../notifications/emit-signal.js";
import type { NotificationSourceChannel } from "../../../notifications/signal.js";
import { canonicalizeInboundIdentity } from "../../../util/canonicalize-identity.js";
import { getLogger } from "../../../util/logger.js";
import {
  findActiveSession,
  getGuardianBinding,
  getPendingSession,
  validateAndConsumeVerification,
} from "../../channel-verification-service.js";
import { deliverChannelReply } from "../../gateway-client.js";
import {
  composeChannelVerifyReply,
  GUARDIAN_VERIFY_TEMPLATE_KEYS,
} from "../../verification-templates.js";
import { stripVerificationFailurePrefix } from "../channel-route-shared.js";

const log = getLogger("runtime-http");

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface GatewayVerificationSignal {
  outcome: "verified" | "failed";
  verificationType?: "guardian" | "trusted_contact";
  bindingConflict?: boolean;
  failureReason?: string;
}

export interface VerificationInterceptParams {
  isDuplicate: boolean;
  guardianVerifyCode: string | undefined;
  rawSenderId: string | undefined;
  canonicalSenderId: string | null;
  canonicalAssistantId: string;
  sourceChannel: ChannelId;
  conversationExternalId: string;
  conversationId: string;
  eventId: string;
  replyCallbackUrl: string | undefined;
  assistantId: string;
  actorDisplayName: string | undefined;
  actorUsername: string | undefined;
  gatewayVerification?: GatewayVerificationSignal;
}

/**
 * Intercept guardian verification codes and handle them deterministically.
 *
 * Bare 6-digit codes are only intercepted when there is actually a
 * pending challenge or active outbound session for this channel.
 * Without this guard, normal 6-digit messages (zip codes, PINs, etc.)
 * would be swallowed by the verification handler and never reach the
 * agent pipeline.
 *
 * Returns a Response if the verification was handled, or null to continue
 * the pipeline.
 */
export async function handleVerificationIntercept(
  params: VerificationInterceptParams,
): Promise<Record<string, unknown> | null> {
  const {
    isDuplicate,
    guardianVerifyCode,
    rawSenderId,
    canonicalSenderId,
    canonicalAssistantId,
    sourceChannel,
    conversationExternalId,
    conversationId,
    eventId,
    replyCallbackUrl,
    assistantId,
    actorDisplayName,
    actorUsername,
    gatewayVerification,
  } = params;

  // ── Gateway pre-validated path ─────────────────────────────────────
  // When the gateway has already validated the code, consumed the session,
  // and created the binding, we trust its verdict. The assistant handles
  // only contact upsert, notification signals, and reply delivery.
  if (gatewayVerification) {
    if (isDuplicate || !rawSenderId) return null;

    const gwOutcome = gatewayVerification.outcome;
    const gwVerificationType = gatewayVerification.verificationType;

    if (gwOutcome === "verified") {
      const existingContactResult =
        (canonicalSenderId ?? rawSenderId)
          ? findContactChannel({
              channelType: sourceChannel,
              externalUserId: canonicalSenderId ?? rawSenderId,
              externalChatId: conversationExternalId,
            })
          : null;
      const existingChannel = existingContactResult?.channel ?? null;
      const existingContact = existingContactResult?.contact ?? null;
      const memberMatchesSender = existingChannel?.externalUserId
        ? canonicalizeInboundIdentity(
            sourceChannel,
            existingChannel.externalUserId,
          ) === (canonicalSenderId ?? rawSenderId)
        : false;
      const preservedDisplayName =
        memberMatchesSender && existingContact?.displayName?.trim().length
          ? existingContact.displayName
          : actorDisplayName;

      upsertContactChannel({
        sourceChannel,
        externalUserId: canonicalSenderId ?? rawSenderId,
        externalChatId: conversationExternalId,
        status: "active",
        policy: "allow",
        displayName: preservedDisplayName,
        username: actorUsername,
      });

      log.info(
        { sourceChannel, verificationType: gwVerificationType },
        "Gateway-verified: auto-upserted ingress member",
      );

      if (gwVerificationType === "trusted_contact") {
        void emitNotificationSignal({
          sourceEventName: "ingress.trusted_contact.activated",
          sourceChannel: sourceChannel as NotificationSourceChannel,
          sourceContextId: conversationId,
          attentionHints: {
            requiresAction: false,
            urgency: "low",
            isAsyncBackground: false,
            visibleInSourceNow: false,
          },
          contextPayload: {
            sourceChannel,
            actorExternalId: canonicalSenderId ?? rawSenderId,
            conversationExternalId,
            actorDisplayName: actorDisplayName ?? null,
            actorUsername: actorUsername ?? null,
          },
          dedupeKey: `trusted-contact:activated:${canonicalAssistantId}:${sourceChannel}:${
            canonicalSenderId ?? rawSenderId
          }`,
        });
      }
    }

    return deliverVerificationReply({
      outcome: gwOutcome,
      verificationType: gwVerificationType,
      failureReason: gatewayVerification.failureReason,
      replyCallbackUrl,
      conversationExternalId,
      assistantId,
      eventId,
    });
  }

  // ── Legacy path (no gateway signal) ────────────────────────────────
  // Fallback for when the gateway hasn't intercepted (e.g. direct IPC
  // inbound, older gateway versions). Full validation + binding here.
  const shouldIntercept =
    guardianVerifyCode !== undefined &&
    (!!getPendingSession(sourceChannel) || !!findActiveSession(sourceChannel));

  if (
    isDuplicate ||
    !shouldIntercept ||
    guardianVerifyCode === undefined ||
    !rawSenderId
  ) {
    return null;
  }

  const verifyResult = validateAndConsumeVerification(
    sourceChannel,
    guardianVerifyCode,
    canonicalSenderId ?? rawSenderId,
    conversationExternalId,
    actorUsername,
    actorDisplayName,
  );

  const guardianVerifyOutcome: "verified" | "failed" = verifyResult.success
    ? "verified"
    : "failed";

  if (verifyResult.success) {
    const existingContactResult =
      (canonicalSenderId ?? rawSenderId)
        ? findContactChannel({
            channelType: sourceChannel,
            externalUserId: canonicalSenderId ?? rawSenderId,
            externalChatId: conversationExternalId,
          })
        : null;
    const existingChannel = existingContactResult?.channel ?? null;
    const existingContact = existingContactResult?.contact ?? null;
    const memberMatchesSender = existingChannel?.externalUserId
      ? canonicalizeInboundIdentity(
          sourceChannel,
          existingChannel.externalUserId,
        ) === (canonicalSenderId ?? rawSenderId)
      : false;
    const preservedDisplayName =
      memberMatchesSender && existingContact?.displayName?.trim().length
        ? existingContact.displayName
        : actorDisplayName;

    upsertContactChannel({
      sourceChannel,
      externalUserId: canonicalSenderId ?? rawSenderId,
      externalChatId: conversationExternalId,
      status: "active",
      policy: "allow",
      displayName: preservedDisplayName,
      username: actorUsername,
    });

    if (verifyResult.verificationType === "guardian") {
      const existingBinding = getGuardianBinding(
        canonicalAssistantId,
        sourceChannel,
      );
      if (
        existingBinding &&
        existingBinding.guardianExternalUserId !==
          (canonicalSenderId ?? rawSenderId)
      ) {
        log.warn(
          {
            sourceChannel,
            existingGuardian: existingBinding.guardianExternalUserId,
          },
          "Guardian binding conflict: another user already holds this channel binding",
        );
      } else {
        revokeGuardianBinding(sourceChannel);

        const metadata: Record<string, string> = {};
        if (actorUsername && actorUsername.trim().length > 0) {
          metadata.username = actorUsername.trim();
        }
        if (actorDisplayName && actorDisplayName.trim().length > 0) {
          metadata.displayName = actorDisplayName.trim();
        }

        const vellumBinding = getGuardianBinding(
          canonicalAssistantId,
          "vellum",
        );
        const canonicalPrincipal =
          vellumBinding?.guardianPrincipalId ??
          canonicalSenderId ??
          rawSenderId;

        createGuardianBinding({
          channel: sourceChannel,
          guardianExternalUserId: canonicalSenderId ?? rawSenderId,
          guardianDeliveryChatId: conversationExternalId,
          guardianPrincipalId: canonicalPrincipal,
          verifiedVia: "challenge",
          metadataJson:
            Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null,
        });
      }
    }

    log.info(
      {
        sourceChannel,
        externalUserId: canonicalSenderId,
        verificationType: verifyResult.verificationType,
      },
      "Legacy path: verified and auto-upserted ingress member",
    );

    if (verifyResult.verificationType === "trusted_contact") {
      void emitNotificationSignal({
        sourceEventName: "ingress.trusted_contact.activated",
        sourceChannel: sourceChannel as NotificationSourceChannel,
        sourceContextId: conversationId,
        attentionHints: {
          requiresAction: false,
          urgency: "low",
          isAsyncBackground: false,
          visibleInSourceNow: false,
        },
        contextPayload: {
          sourceChannel,
          actorExternalId: canonicalSenderId ?? rawSenderId,
          conversationExternalId,
          actorDisplayName: actorDisplayName ?? null,
          actorUsername: actorUsername ?? null,
        },
        dedupeKey: `trusted-contact:activated:${canonicalAssistantId}:${sourceChannel}:${
          canonicalSenderId ?? rawSenderId
        }`,
      });
    }
  }

  return deliverVerificationReply({
    outcome: guardianVerifyOutcome,
    verificationType: verifyResult.success ? verifyResult.verificationType : undefined,
    failureReason: verifyResult.success ? undefined : stripVerificationFailurePrefix(verifyResult.reason),
    replyCallbackUrl,
    conversationExternalId,
    assistantId,
    eventId,
  });
}

// ---------------------------------------------------------------------------
// Reply delivery helper (shared by gateway-verified and legacy paths)
// ---------------------------------------------------------------------------

async function deliverVerificationReply(params: {
  outcome: "verified" | "failed";
  verificationType?: "guardian" | "trusted_contact";
  failureReason?: string;
  replyCallbackUrl: string | undefined;
  conversationExternalId: string;
  assistantId: string;
  eventId: string;
}): Promise<Record<string, unknown>> {
  const {
    outcome,
    verificationType,
    failureReason,
    replyCallbackUrl,
    conversationExternalId,
    assistantId,
    eventId,
  } = params;

  if (replyCallbackUrl) {
    let replyText: string;
    if (outcome === "failed") {
      replyText = composeChannelVerifyReply(
        GUARDIAN_VERIFY_TEMPLATE_KEYS.CHANNEL_VERIFY_FAILED,
        { failureReason: failureReason ?? "The verification code is invalid or has expired." },
      );
    } else {
      replyText = composeChannelVerifyReply(
        GUARDIAN_VERIFY_TEMPLATE_KEYS.CHANNEL_VERIFY_SUCCESS,
        { verificationType },
      );
    }
    try {
      await deliverChannelReply(replyCallbackUrl, {
        chatId: conversationExternalId,
        text: replyText,
        assistantId,
      });
    } catch (err) {
      log.error(
        { err, conversationExternalId },
        "Failed to deliver deterministic verification reply; persisting for retry",
      );
      storePendingVerificationReply(eventId, {
        chatId: conversationExternalId,
        text: replyText,
        assistantId,
      });

      setTimeout(async () => {
        try {
          await deliverChannelReply(replyCallbackUrl, {
            chatId: conversationExternalId,
            text: replyText,
            assistantId,
          });
          log.info({ eventId }, "Verification reply delivered on self-retry");
          clearPendingVerificationReply(eventId);
        } catch (retryErr) {
          log.error(
            { err: retryErr, eventId },
            "Verification reply self-retry also failed; pending reply remains as fallback",
          );
        }
      }, 3000);

      return {
        accepted: true,
        duplicate: false,
        eventId,
        verificationOutcome: outcome,
        deliveryPending: true,
      };
    }
  }

  return {
    accepted: true,
    duplicate: false,
    eventId,
    verificationOutcome: outcome,
  };
}
