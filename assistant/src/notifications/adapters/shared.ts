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
 * Append an approval's typed-command instructions to the message text, when
 * the copy does not already carry them. Used by adapters delivering an
 * approval without live buttons (Discord always; Telegram when its rich
 * delivery fails), so the guardian still knows how to decide.
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
