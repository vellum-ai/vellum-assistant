/**
 * Periodic sweep for expired guardian action requests.
 *
 * Runs on a 60-second interval. When a request has passed its expiresAt
 * timestamp:
 * 1. Expires the request and all its deliveries in the store
 * 2. Expires the associated pending question so the call-side timeout fires
 * 3. Sends expiry notices to external delivery destinations (telegram)
 * 4. Adds an expiry message to mac guardian conversations
 */

import { addMessage } from "../memory/conversation-crud.js";
import {
  expireGuardianActionRequest,
  getDeliveriesByRequestId,
  getExpiredGuardianActionRequests,
} from "../memory/guardian-action-store.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../runtime/assistant-scope.js";
import { deliverChannelReply } from "../runtime/gateway-client.js";
import { composeGuardianActionMessageGenerative } from "../runtime/guardian-action-message-composer.js";
import type { GuardianActionCopyGenerator } from "../runtime/http-types.js";
import { getLogger } from "../util/logger.js";
import { expirePendingQuestions } from "./call-store.js";

const log = getLogger("guardian-action-sweep");

const SWEEP_INTERVAL_MS = 60_000;

let sweepTimer: ReturnType<typeof setInterval> | null = null;
let sweepInProgress = false;

/**
 * Send expiry notices to all delivery destinations for a guardian action
 * request. Handles both vellum/mac conversation messages and external channel
 * replies (telegram, slack).
 *
 * Deliveries must be captured *before* their status is changed to 'expired'
 * so the sent/pending filter still matches.
 */
/** Minimal delivery shape used by the expiry notice sender. */
export interface ExpiryDeliveryInfo {
  id: string;
  status: string;
  destinationChannel: string;
  destinationConversationId: string | null;
  destinationChatId: string | null;
}

export async function sendGuardianExpiryNotices(
  deliveries: ExpiryDeliveryInfo[],
  assistantId: string,
  gatewayBaseUrl: string,
  mintBearerToken?: () => string,
  guardianActionCopyGenerator?: GuardianActionCopyGenerator,
): Promise<void> {
  for (const delivery of deliveries) {
    if (delivery.status !== "sent" && delivery.status !== "pending") continue;

    try {
      const expiryText = await composeGuardianActionMessageGenerative(
        {
          scenario: "guardian_stale_expired",
          channel: delivery.destinationChannel,
        },
        {},
        guardianActionCopyGenerator,
      );

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
            userMessageChannel: "phone",
            assistantMessageChannel: "vellum",
            userMessageInterface: "phone",
            assistantMessageInterface: "vellum",
          },
        );
      } else if (delivery.destinationChatId) {
        // External channel — send expiry notice
        const deliverUrl = `${gatewayBaseUrl}/deliver/${delivery.destinationChannel}`;
        await deliverChannelReply(
          deliverUrl,
          {
            chatId: delivery.destinationChatId,
            text: expiryText,
            assistantId,
          },
          mintBearerToken?.(),
        );
      }
    } catch (err) {
      log.error(
        { err, deliveryId: delivery.id, channel: delivery.destinationChannel },
        "Failed to compose or deliver guardian action expiry notice",
      );
    }
  }
}

/**
 * Sweep expired guardian action requests and clean up.
 */
export async function sweepExpiredGuardianActions(
  gatewayBaseUrl: string,
  mintBearerToken?: () => string,
  guardianActionCopyGenerator?: GuardianActionCopyGenerator,
): Promise<void> {
  const expired = getExpiredGuardianActionRequests();

  for (const request of expired) {
    // Capture deliveries before expiring (since expiry changes their status)
    const deliveries = getDeliveriesByRequestId(request.id);

    // Expire the request and all deliveries
    expireGuardianActionRequest(request.id, "sweep_timeout");

    // Expire associated pending questions
    expirePendingQuestions(request.callSessionId);

    log.info(
      { requestId: request.id, callSessionId: request.callSessionId },
      "Expired guardian action request",
    );

    await sendGuardianExpiryNotices(
      deliveries,
      DAEMON_INTERNAL_ASSISTANT_ID,
      gatewayBaseUrl,
      mintBearerToken,
      guardianActionCopyGenerator,
    );
  }
}

export function startGuardianActionSweep(
  gatewayBaseUrl: string,
  mintBearerToken?: () => string,
  guardianActionCopyGenerator?: GuardianActionCopyGenerator,
): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(async () => {
    if (sweepInProgress) return;
    sweepInProgress = true;
    try {
      await sweepExpiredGuardianActions(
        gatewayBaseUrl,
        mintBearerToken,
        guardianActionCopyGenerator,
      );
    } catch (err) {
      log.error({ err }, "Guardian action sweep failed");
    } finally {
      sweepInProgress = false;
    }
  }, SWEEP_INTERVAL_MS);
}

export function stopGuardianActionSweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  sweepInProgress = false;
}
