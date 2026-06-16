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
  if (deliveryText) return deliveryText;

  if (isConversationSeedSane(payload.copy.conversationSeedMessage)) {
    return payload.copy.conversationSeedMessage.trim();
  }

  const body = nonEmpty(payload.copy.body);
  if (body) return body;

  const title = nonEmpty(payload.copy.title);
  if (title) return title;

  return payload.sourceEventName.replace(/[._]/g, " ");
}
