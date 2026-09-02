/**
 * Shared adapter utilities — functions used by multiple channel adapters.
 */

import { isConversationSeedSane } from "../conversation-seed-composer.js";
import { nonEmpty } from "../notification-utils.js";
import type { ChannelDeliveryPayload } from "../types.js";

/**
 * Resolve the primary message text for a notification delivery.
 *
 * Cascade: deliveryText → conversationSeedMessage → body → title → event name.
 */
export function resolveMessageText(payload: ChannelDeliveryPayload): string {
  const deliveryText = nonEmpty(payload.copy.deliveryText);
  if (deliveryText) {
    return deliveryText;
  }

  if (isConversationSeedSane(payload.copy.conversationSeedMessage)) {
    return payload.copy.conversationSeedMessage.trim();
  }

  const body = nonEmpty(payload.copy.body);
  if (body) {
    return body;
  }

  const title = nonEmpty(payload.copy.title);
  if (title) {
    return title;
  }

  return payload.sourceEventName.replace(/[._]/g, " ");
}

/**
 * Whether an approval context has buttons to draw. A context with no actions
 * (an option-less question) is answered by typed reply, so it takes the
 * plain-text path with {@link appendPlainTextFallback} rather than a card
 * with nothing on it.
 */
export function rendersActions(
  approval: ChannelDeliveryPayload["approvalContext"],
): approval is NonNullable<ChannelDeliveryPayload["approvalContext"]> {
  return approval != null && approval.actions.length > 0;
}

/**
 * Append an approval's typed-reply instructions to the message text, when
 * the text does not already carry them. This is the only place reply
 * mechanics join a message: composed copy never carries them, so an adapter
 * sending text without live buttons (no actions to draw, or a rich delivery
 * that failed) appends them here and the guardian still knows how to answer.
 */
export function appendPlainTextFallback(
  text: string,
  approval: ChannelDeliveryPayload["approvalContext"],
): string {
  return approval?.plainTextFallback &&
    !text.includes(approval.plainTextFallback)
    ? `${text}\n\n${approval.plainTextFallback}`
    : text;
}
