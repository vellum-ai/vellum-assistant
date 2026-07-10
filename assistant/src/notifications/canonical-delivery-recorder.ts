/**
 * The single sink for the per-(request, surface) guardian-request delivery
 * registry (the gateway's `guardian_request_deliveries` table).
 *
 * Guardian-request producers (access requests, tool approvals, tool-grant
 * escalations, voice questions, trusted-contact confirmations) emit a
 * notification signal and then record one delivery row per surface the card
 * reached. Capturing the surface address here — the conversation id for the
 * in-app vellum card, or the channel-native message id (e.g. Slack `ts`) for a
 * channel card — is what lets a delivered card be addressed back to its request
 * later:
 *
 *   - to withdraw it in place when the request resolves
 *     (`approvals/guardian-card-withdrawal.ts`), and
 *   - to resolve an emoji reaction on the card to the right request when several
 *     are pending in the same chat (the by-destination-message lookup).
 *
 * Every producer records through here so the addressing convention lives in one
 * place and cannot drift between the path that writes the row and the paths that
 * read it back.
 */

import {
  createGuardianRequestDelivery,
  type GuardianRequestDeliveryWire,
  updateGuardianRequestDelivery,
} from "../channels/gateway-guardian-requests.js";
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
 * errors — gateway-unreachable included — are swallowed and logged and `null`
 * is returned. Callers that need the row id (to apply a status afterwards)
 * must null-check the result.
 */
export async function recordApprovalCardDelivery(
  address: ApprovalCardDeliveryAddress,
): Promise<GuardianRequestDeliveryWire | null> {
  try {
    return await createGuardianRequestDelivery({
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
 * Record every delivery for a guardian request from a notification signal's
 * results, persisting each delivery's terminal status.
 *
 * This is the shared post-broadcast recording loop for the signal-based
 * producers. The vellum row is normally created up front in the signal's
 * `onConversationCreated` callback so the in-app client sees it immediately; pass
 * that row's id as `vellumDeliveryId` and it is reused (only its status applied)
 * — otherwise the vellum row is created here from the result.
 *
 * Every result records the internal `conversationId` the card is shown in, so a
 * conversation's pending cards can be found uniformly regardless of channel.
 * Channel results additionally carry the chat (`destination`) and channel-native
 * id (`messageId`) used to match inbound replies/reactions; a blank `destination`
 * is recorded as unknown rather than persisting the literal channel name as a
 * chat id. Status is diagnostic — the read paths key off addressing, not status.
 *
 * Best-effort like the create: a status-patch failure is logged, not thrown.
 *
 * Returns the vellum delivery id (passed in, or created here) so a caller can
 * record its own "pipeline produced no vellum delivery" fallback.
 */
export async function recordGuardianRequestDeliveries(params: {
  requestId: string;
  deliveryResults: NotificationDeliveryResult[];
  vellumDeliveryId?: string;
}): Promise<string | undefined> {
  const { requestId, deliveryResults } = params;
  let vellumDeliveryId = params.vellumDeliveryId;

  for (const result of deliveryResults) {
    let deliveryId: string | undefined;
    if (result.channel === "vellum") {
      if (!vellumDeliveryId) {
        vellumDeliveryId = (
          await recordApprovalCardDelivery({
            requestId,
            channel: "vellum",
            conversationId: result.conversationId,
          })
        )?.id;
      }
      deliveryId = vellumDeliveryId;
    } else {
      deliveryId = (
        await recordApprovalCardDelivery({
          requestId,
          channel: result.channel,
          conversationId: result.conversationId,
          chatId:
            result.destination.length > 0 ? result.destination : undefined,
          messageId: result.messageId,
        })
      )?.id;
    }

    if (deliveryId) {
      try {
        await updateGuardianRequestDelivery(deliveryId, {
          status: result.status === "sent" ? "sent" : "failed",
        });
      } catch (err) {
        log.error(
          { err, requestId, deliveryId },
          "Failed to record approval card delivery status",
        );
      }
    }
  }

  return vellumDeliveryId;
}
