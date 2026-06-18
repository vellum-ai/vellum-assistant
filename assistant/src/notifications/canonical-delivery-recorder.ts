/**
 * The single sink for the per-(request, surface) `canonical_guardian_deliveries`
 * registry.
 *
 * Guardian-request producers (access requests, tool approvals, tool-grant
 * escalations, voice questions, trusted-contact confirmations) emit a
 * notification signal and then record one canonical delivery row per surface the
 * card reached. Capturing the surface address here — the conversation id for the
 * in-app vellum card, or the channel-native message id (e.g. Slack `ts`) for a
 * channel card — is what lets a delivered card be addressed back to its request
 * later:
 *
 *   - to withdraw it in place when the request resolves
 *     (`approvals/guardian-card-withdrawal.ts`), and
 *   - to resolve an emoji reaction on the card to the right request when several
 *     are pending in the same chat
 *     (`getPendingCanonicalRequestByDestinationMessage`).
 *
 * Every producer records through `recordApprovalCardDelivery` so the addressing
 * convention lives in exactly one place and cannot drift between the path that
 * writes the row and the paths that read it back.
 */

import {
  type CanonicalGuardianDelivery,
  createCanonicalGuardianDelivery,
  updateCanonicalGuardianDelivery,
} from "../memory/canonical-guardian-store.js";
import { getLogger } from "../util/logger.js";
import type { NotificationDeliveryResult } from "./types.js";

const log = getLogger("canonical-delivery-recorder");

/**
 * Where an approval card was delivered. Exactly one addressing modality is
 * meaningful per channel:
 *
 *   - vellum (in-app): addressed by `conversationId` + the card's surface id.
 *   - channels (slack/telegram/...): addressed by `chatId` + the channel-native
 *     `messageId` (Slack `ts`).
 */
export interface ApprovalCardDeliveryAddress {
  requestId: string;
  channel: string;
  /** In-app vellum addressing: the conversation the card was posted to. */
  conversationId?: string;
  /** Channel addressing: the chat the card was delivered to. */
  chatId?: string;
  /** Channel-native message id (e.g. Slack `ts`) — the reaction/withdrawal key. */
  messageId?: string;
  /** Initial delivery status (defaults to "pending"). */
  status?: string;
}

/**
 * Record where an approval card was delivered so it can be located later.
 *
 * Best-effort: a recording failure must never be mistaken for a delivery
 * failure (which, in the prompt path, would trigger a fallback re-post), so
 * errors are swallowed and logged and `null` is returned. Callers that need the
 * row id (to apply a status afterwards) must null-check the result.
 */
export function recordApprovalCardDelivery(
  address: ApprovalCardDeliveryAddress,
): CanonicalGuardianDelivery | null {
  try {
    return createCanonicalGuardianDelivery({
      requestId: address.requestId,
      destinationChannel: address.channel,
      destinationConversationId: address.conversationId,
      destinationChatId: address.chatId,
      destinationMessageId: address.messageId,
      ...(address.status ? { status: address.status } : {}),
    });
  } catch (err) {
    log.error(
      { err, requestId: address.requestId, channel: address.channel },
      "Failed to record approval card delivery; reaction/withdrawal on this card will not resolve",
    );
    return null;
  }
}

/**
 * Record a canonical guardian delivery from a notification-pipeline result.
 *
 * Maps the pipeline's channel-agnostic `NotificationDeliveryResult` onto the
 * addressing sink: the vellum result carries a `conversationId`; channel results
 * carry the delivered chat (`destination`) and channel-native id (`messageId`).
 * A blank `destination` is treated as "unknown" rather than persisting the
 * literal channel name as a chat id.
 */
export function recordChannelDeliveryResult(
  requestId: string,
  result: NotificationDeliveryResult,
): CanonicalGuardianDelivery | null {
  const isVellum = result.channel === "vellum";
  return recordApprovalCardDelivery({
    requestId,
    channel: result.channel,
    conversationId: isVellum ? result.conversationId : undefined,
    chatId:
      !isVellum && result.destination.length > 0
        ? result.destination
        : undefined,
    messageId: isVellum ? undefined : result.messageId,
  });
}

/**
 * Persist the terminal delivery status from a pipeline result onto an existing
 * delivery row. A `sent` result marks the row `sent`; anything else (failed,
 * skipped, pending) marks it `failed` since the card did not reach the surface.
 */
export function applyDeliveryResultStatus(
  deliveryId: string,
  result: NotificationDeliveryResult,
): void {
  updateCanonicalGuardianDelivery(deliveryId, {
    status: result.status === "sent" ? "sent" : "failed",
  });
}
