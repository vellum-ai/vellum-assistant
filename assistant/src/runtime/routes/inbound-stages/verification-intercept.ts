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
import * as deliveryChannels from "../../../memory/delivery-channels.js";
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
  mintBearerToken: () => string;
  assistantId: string;
  actorDisplayName: string | undefined;
  actorUsername: string | undefined;
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
): Promise<Response | null> {
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
    mintBearerToken,
    assistantId,
    actorDisplayName,
    actorUsername,
  } = params;

  // Only intercept when there is a pending challenge or active outbound session
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
      // Keep guardian-curated member name stable across re-verification.
      displayName: preservedDisplayName,
      username: actorUsername,
    });

    // Guardian-specific side effect: create/update the guardian binding.
    // This was previously inside validateAndConsumeVerification but is now
    // handled here so both verification types have symmetric dispatch.
    if (verifyResult.verificationType === "guardian") {
      // Reject if a different user already holds the guardian binding
      const existingBinding = getGuardianBinding(
        canonicalAssistantId,
        sourceChannel,
      );
      if (
        existingBinding &&
        existingBinding.guardianExternalUserId !==
          (canonicalSenderId ?? rawSenderId)
      ) {
        // Edge case: another user already bound. Log and skip binding creation.
        // The upsertContactChannel above already succeeded, so the sender is a known contact,
        // but they won't get guardian role.
        log.warn(
          {
            sourceChannel,
            existingGuardian: existingBinding.guardianExternalUserId,
          },
          "Guardian binding conflict: another user already holds this channel binding",
        );
      } else {
        // Revoke any existing active binding before creating a new one (same-user re-verification)
        revokeGuardianBinding(sourceChannel);

        const metadata: Record<string, string> = {};
        if (actorUsername && actorUsername.trim().length > 0) {
          metadata.username = actorUsername.trim();
        }
        if (actorDisplayName && actorDisplayName.trim().length > 0) {
          metadata.displayName = actorDisplayName.trim();
        }

        // Unify all channel bindings onto the canonical (vellum) principal
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

    const verifyLogLabel =
      verifyResult.verificationType === "trusted_contact"
        ? "Trusted contact verified"
        : "Guardian verified";
    log.info(
      {
        sourceChannel,
        externalUserId: canonicalSenderId,
        verificationType: verifyResult.verificationType,
      },
      `${verifyLogLabel}: auto-upserted ingress member`,
    );

    // Emit activated signal when a trusted contact completes verification.
    // Member record is persisted above before this event fires, satisfying
    // the persistence-before-event ordering invariant.
    if (verifyResult.verificationType === "trusted_contact") {
      void emitNotificationSignal({
        sourceEventName: "ingress.trusted_contact.activated",
        sourceChannel: sourceChannel as NotificationSourceChannel,
        sourceSessionId: conversationId,
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

  // Deliver a deterministic template-driven reply and short-circuit.
  // Verification code messages must never produce agent-generated copy.
  if (replyCallbackUrl) {
    let replyText: string;
    if (!verifyResult.success) {
      replyText = composeChannelVerifyReply(
        GUARDIAN_VERIFY_TEMPLATE_KEYS.CHANNEL_VERIFY_FAILED,
        { failureReason: stripVerificationFailurePrefix(verifyResult.reason) },
      );
    } else {
      replyText = composeChannelVerifyReply(
        GUARDIAN_VERIFY_TEMPLATE_KEYS.CHANNEL_VERIFY_SUCCESS,
        { verificationType: verifyResult.verificationType },
      );
    }
    try {
      await deliverChannelReply(
        replyCallbackUrl,
        {
          chatId: conversationExternalId,
          text: replyText,
          assistantId,
        },
        mintBearerToken(),
      );
    } catch (err) {
      // The challenge is already consumed and side effects applied, so
      // we cannot simply re-throw and let the gateway retry the full
      // flow. Instead, persist the reply so that gateway retries
      // (which arrive as duplicates) can re-attempt delivery.
      log.error(
        { err, conversationExternalId },
        "Failed to deliver deterministic verification reply; persisting for retry",
      );
      deliveryChannels.storePendingVerificationReply(eventId, {
        chatId: conversationExternalId,
        text: replyText,
        assistantId,
      });

      // Self-retry after a short delay. The gateway deduplicates
      // inbound webhooks after a successful forward, so duplicate
      // retries may never arrive. This fire-and-forget retry ensures
      // delivery is re-attempted even without a gateway duplicate.
      setTimeout(async () => {
        try {
          await deliverChannelReply(
            replyCallbackUrl,
            {
              chatId: conversationExternalId,
              text: replyText,
              assistantId,
            },
            mintBearerToken(),
          );
          log.info({ eventId }, "Verification reply delivered on self-retry");
          deliveryChannels.clearPendingVerificationReply(eventId);
        } catch (retryErr) {
          log.error(
            { err: retryErr, eventId },
            "Verification reply self-retry also failed; pending reply remains as fallback",
          );
        }
      }, 3000);

      return Response.json({
        accepted: true,
        duplicate: false,
        eventId,
        verificationOutcome: guardianVerifyOutcome,
        deliveryPending: true,
      });
    }
  }

  return Response.json({
    accepted: true,
    duplicate: false,
    eventId,
    verificationOutcome: guardianVerifyOutcome,
  });
}
