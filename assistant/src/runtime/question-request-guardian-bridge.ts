/**
 * Bridge a guardian's parked `ask_question` prompt to a `guardian.question`
 * notification.
 *
 * Mirrors `confirmation-request-guardian-bridge.ts` for the question kind:
 * emits the notification signal (the broadcaster renders the options as card
 * actions — see `resolveQuestionOptionsContext`) and records the resulting
 * card deliveries so reply routing can address taps and reactions back to the
 * request.
 *
 * Unlike the confirmation bridge — which escalates a NON-guardian's request TO
 * the guardian — the caller (`question-guardian-request.ts`) has already
 * established that the asking turn belongs to the guardian; this bridge only
 * verifies the channel's guardian binding still matches so a rebind between
 * ingress and prompt emission can't deliver the question card to the wrong
 * recipient.
 */

import type { QuestionEntry } from "../api/events/question-request.js";
import type { GuardianRequestWire } from "../channels/gateway-guardian-requests.js";
import type { TrustContext } from "../daemon/trust-context-types.js";
import { emitNotificationSignal } from "../notifications/emit-signal.js";
import {
  recordApprovalCardDelivery,
  recordGuardianRequestDeliveries,
} from "../notifications/guardian-delivery-recorder.js";
import { buildVellumCardAffinity } from "../notifications/vellum-card-affinity.js";
import { canonicalizeInboundIdentity } from "../util/canonicalize-identity.js";
import { getLogger } from "../util/logger.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "./assistant-scope.js";
import { getGuardianBinding } from "./channel-verification-service.js";

const log = getLogger("question-request-guardian-bridge");

export interface BridgeQuestionRequestParams {
  /** The guardian request already persisted for this question. */
  guardianRequest: GuardianRequestWire;
  /** Trust context snapshot from the asking turn. */
  trustContext: TrustContext;
  /** Conversation the question was asked in. */
  conversationId: string;
  /** The (single) question entry being asked. */
  question: QuestionEntry;
  /** Logical assistant ID (defaults to 'self'). */
  assistantId?: string;
}

export type BridgeQuestionRequestResult =
  | { bridged: true; signalId: string }
  | {
      skipped: true;
      reason: "no_guardian_binding" | "binding_identity_mismatch";
    };

/**
 * Emit the `guardian.question` signal for a parked question and record the
 * card deliveries. Fire-and-forget safe: emission errors are logged, never
 * propagated.
 */
export async function bridgeQuestionRequestToGuardian(
  params: BridgeQuestionRequestParams,
): Promise<BridgeQuestionRequestResult> {
  const {
    guardianRequest,
    trustContext,
    conversationId,
    question,
    assistantId = DAEMON_INTERNAL_ASSISTANT_ID,
  } = params;

  const sourceChannel = trustContext.sourceChannel;
  const binding = await getGuardianBinding(assistantId, sourceChannel);
  if (!binding) {
    log.debug(
      { sourceChannel, conversationId },
      "No guardian binding for question request bridge",
    );
    return { skipped: true, reason: "no_guardian_binding" };
  }

  // A guardian rebind between ingress and prompt emission would deliver the
  // question card to the wrong recipient — mirror the confirmation bridge's
  // canonicalized identity check.
  const canonicalizedBindingGuardianId = canonicalizeInboundIdentity(
    sourceChannel,
    binding.guardianExternalUserId,
  );
  const canonicalizedRequestGuardianId = guardianRequest.guardianExternalUserId
    ? canonicalizeInboundIdentity(
        sourceChannel,
        guardianRequest.guardianExternalUserId,
      )
    : null;
  if (
    canonicalizedRequestGuardianId &&
    canonicalizedBindingGuardianId !== canonicalizedRequestGuardianId
  ) {
    log.warn(
      {
        sourceChannel,
        requestId: guardianRequest.id,
      },
      "Guardian binding identity does not match the question request guardian — skipping notification to prevent misrouting",
    );
    return { skipped: true, reason: "binding_identity_mismatch" };
  }

  // The vellum delivery row is created up front in onConversationCreated so
  // the in-app client sees it immediately; the post-resolve recorder reuses it.
  let vellumDeliveryIdPromise: Promise<string | undefined> | undefined;

  const signalPromise = emitNotificationSignal({
    sourceEventName: "guardian.question",
    sourceChannel,
    sourceContextId: conversationId,
    requiresConversation: true,
    // Pin the in-app (vellum) card to the conversation the question was
    // asked in, so the guardian answers it in context.
    ...(buildVellumCardAffinity(conversationId) ?? {}),
    attentionHints: {
      requiresAction: true,
      urgency: "high",
      isAsyncBackground: false,
      // MUST be false: visibleInSourceNow is a hard suppression pre-gate in
      // emitNotificationSignal (source-active check) — it means "the user can
      // already see this content in the source surface, skip notifying". A
      // parked ask_question renders NOTHING in the source chat by itself; this
      // card IS the prompt, so suppressing it would leave the turn hanging
      // until the prompt timeout.
      visibleInSourceNow: false,
    },
    contextPayload: {
      requestKind: "pending_question",
      requestId: guardianRequest.id,
      requestCode:
        guardianRequest.requestCode ??
        guardianRequest.id.slice(0, 6).toUpperCase(),
      sourceChannel,
      requesterExternalUserId: trustContext.requesterExternalUserId,
      requesterChatId: trustContext.requesterChatId ?? null,
      questionText: question.question,
      options: question.options.map((option) => ({
        id: option.id,
        label: option.label,
      })),
    },
    dedupeKey: `ask-question-request:${guardianRequest.id}`,
    onConversationCreated: (info) => {
      vellumDeliveryIdPromise ??= recordApprovalCardDelivery({
        requestId: guardianRequest.id,
        channel: "vellum",
        conversationId: info.conversationId,
      }).then((delivery) => delivery?.id);
      return vellumDeliveryIdPromise.then(() => undefined);
    },
  });

  void signalPromise
    .then(async (signalResult) => {
      await recordGuardianRequestDeliveries({
        requestId: guardianRequest.id,
        deliveryResults: signalResult.deliveryResults,
        vellumDeliveryId: await vellumDeliveryIdPromise,
      });
    })
    .catch((err) => {
      log.warn(
        { err, requestId: guardianRequest.id },
        "Failed to record channel deliveries for question bridge",
      );
    });

  log.info(
    {
      sourceChannel,
      requestId: guardianRequest.id,
      requestCode: guardianRequest.requestCode,
      optionCount: question.options.length,
    },
    "Guardian notified of pending question",
  );

  return { bridged: true, signalId: guardianRequest.id };
}
