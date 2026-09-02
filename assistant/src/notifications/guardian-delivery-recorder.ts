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
 * later, to withdraw it in place when the request resolves
 * (`approvals/guardian-card-withdrawal.ts`).
 *
 * Every producer records through here so the addressing convention lives in one
 * place and cannot drift between the path that writes the row and the paths that
 * read it back.
 */

import { DELIVERY_STATUS } from "@vellumai/gateway-client";

import {
  createGuardianRequestDelivery,
  getGuardianRequestOrNull,
  type GuardianRequestDeliveryWire,
  updateGuardianRequestDelivery,
} from "../channels/gateway-guardian-requests.js";
import { getLogger } from "../util/logger.js";
import type { NotificationDeliveryResult } from "./types.js";

const log = getLogger("guardian-delivery-recorder");

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
  /** Channel-native message id (e.g. Slack `ts`): the withdrawal key. */
  messageId?: string;
  /** Initial delivery status (defaults to `DELIVERY_STATUS.pending`). */
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
      "Failed to record approval card delivery; withdrawal of this card will not resolve",
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
 * The vellum result records the internal `conversationId` its card is shown
 * in. Channel guardian cards pair no conversation (they are delivery
 * projections; see `conversation-pairing.ts`), so their rows carry no
 * `conversationId`. Platform push results are skipped entirely: a push
 * has no channel-native card surface to address back to.
 * Channel results additionally carry the chat (`destination`) and channel-native
 * id (`messageId`) used to match inbound replies; a blank `destination`
 * is recorded as unknown rather than persisting the literal channel name as a
 * chat id. Status has two readers: the voice guardian-action sweep acts only
 * on `sent`/`pending` rows, and card withdrawal skips rows already marked
 * `withdrawn` (its per-surface receipt). Addressing lookups ignore status.
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
    if (result.channel === "platform") {
      // A push is not an independently addressable card surface -- no row.
      continue;
    }
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
          status:
            result.status === "sent"
              ? DELIVERY_STATUS.sent
              : DELIVERY_STATUS.failed,
        });
      } catch (err) {
        log.error(
          { err, requestId, deliveryId },
          "Failed to record approval card delivery status",
        );
      }
    }
  }

  await withdrawIfRequestAlreadyTerminal(requestId);

  return vellumDeliveryId;
}

/**
 * Close the delivery/decision race: recording happens after the notification
 * pipeline finishes, so a guardian who acts on a card the moment it lands can
 * resolve the request before its delivery rows exist. That decision's
 * withdrawal pass then finds nothing to withdraw, and the rows recorded here
 * would describe live cards for an already-terminal request. Re-running
 * withdrawal after recording converges them; rows a prior pass already
 * withdrew are skipped, so the overlap never re-edits a surface.
 *
 * Best-effort like the rest of the recorder; the decided action isn't
 * recoverable here, so denied outcomes render the plain status word.
 */
async function withdrawIfRequestAlreadyTerminal(
  requestId: string,
): Promise<void> {
  const request = await getGuardianRequestOrNull(requestId);
  if (!request || request.status === "pending") {
    return;
  }
  // Imported at call time: the withdrawal module reaches the daemon's
  // conversation-surface graph, and a static import here would put this
  // recorder (imported by the guardian-request producers) into that cycle.
  const { withdrawGuardianRequestCards } =
    await import("../approvals/guardian-card-withdrawal.js");
  await withdrawGuardianRequestCards({
    request,
    status: request.status,
  });
}
