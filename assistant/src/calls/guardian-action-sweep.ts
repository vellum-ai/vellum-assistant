/**
 * Guardian action expiry notices.
 *
 * Sends "this request has expired" notices to guardian delivery
 * destinations — vellum conversations get an assistant message, external
 * channels (telegram, slack) get a direct channel reply.
 */

import { addMessage } from "../persistence/conversation-crud.js";
import { deliverChannelReply } from "../runtime/gateway-client.js";
import { composeGuardianActionMessageGenerative } from "../runtime/guardian-action-message-composer.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("guardian-action-sweep");

/** Minimal delivery shape used by the expiry notice sender. */
export interface ExpiryDeliveryInfo {
  id: string;
  status: string;
  destinationChannel: string;
  destinationConversationId: string | null;
  destinationChatId: string | null;
}

/**
 * Send expiry notices to all delivery destinations for a guardian action
 * request. Handles both vellum/mac conversation messages and external channel
 * replies (telegram, slack).
 *
 * Deliveries must be captured *before* their status is changed to 'expired'
 * so the sent/pending filter still matches.
 */
export async function sendGuardianExpiryNotices(
  deliveries: ExpiryDeliveryInfo[],
  assistantId: string,
): Promise<void> {
  for (const delivery of deliveries) {
    if (delivery.status !== "sent" && delivery.status !== "pending") continue;

    try {
      const expiryText = await composeGuardianActionMessageGenerative({
        scenario: "guardian_stale_expired",
        channel: delivery.destinationChannel,
      });

      if (
        delivery.destinationChannel === "vellum" &&
        delivery.destinationConversationId
      ) {
        // Add expiry message to vellum guardian conversation.
        await addMessage(
          delivery.destinationConversationId,
          "assistant",
          JSON.stringify([{ type: "text", text: expiryText }]),
          {
            metadata: {
              userMessageChannel: "phone",
              assistantMessageChannel: "vellum",
              userMessageInterface: "phone",
              assistantMessageInterface: "web",
            },
          },
        );
      } else if (delivery.destinationChatId) {
        // External channel — send expiry notice via direct delivery
        const deliverUrl = `/deliver/${delivery.destinationChannel}`;
        await deliverChannelReply(deliverUrl, {
          chatId: delivery.destinationChatId,
          text: expiryText,
          assistantId,
        });
      }
    } catch (err) {
      log.error(
        { err, deliveryId: delivery.id, channel: delivery.destinationChannel },
        "Failed to compose or deliver guardian action expiry notice",
      );
    }
  }
}
