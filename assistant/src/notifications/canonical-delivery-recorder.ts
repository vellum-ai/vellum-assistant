/**
 * Bridge from notification-pipeline delivery results to the per-request
 * `canonical_guardian_deliveries` registry.
 *
 * Guardian-request producers (access requests, tool approvals, tool-grant
 * escalations, voice questions) emit a notification signal and then record one
 * canonical delivery row per surface the card reached. Capturing the
 * channel-native message id (e.g. Slack `ts`) here is what lets a delivered
 * card be addressed back to its request later: to withdraw it in place when the
 * request resolves (`approvals/guardian-card-withdrawal.ts`), and to resolve an
 * emoji reaction on the card to the right request when several are pending in
 * the same chat.
 */

import {
  type CanonicalGuardianDelivery,
  createCanonicalGuardianDelivery,
} from "../memory/canonical-guardian-store.js";
import type { NotificationDeliveryResult } from "./types.js";

/**
 * Record a canonical guardian delivery for a non-vellum channel result.
 *
 * Vellum deliveries are recorded separately by their producers (via the
 * notification pipeline's `onConversationCreated` callback) because they are
 * addressed by conversation + surface id rather than a channel message id.
 */
export function recordCanonicalChannelDelivery(
  requestId: string,
  result: NotificationDeliveryResult,
): CanonicalGuardianDelivery {
  return createCanonicalGuardianDelivery({
    requestId,
    destinationChannel: result.channel,
    destinationChatId:
      result.destination.length > 0 ? result.destination : undefined,
    destinationMessageId: result.messageId,
  });
}
