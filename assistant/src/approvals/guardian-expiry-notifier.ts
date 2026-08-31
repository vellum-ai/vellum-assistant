/**
 * Expiry side effects for guardian requests.
 *
 * When the expiry sweep transitions a pending request to `expired`,
 * the request's cards are withdrawn — but nobody is told and any in-memory
 * interaction is left dangling. This module fills that gap:
 *
 *  - the requester is told their request expired (for the persistent,
 *    requester-facing kinds: `access_request`, `tool_grant_request`), and
 *  - the in-memory pending interaction is released (for the interaction-bound
 *    `tool_approval` kind).
 *
 * Delivery goes straight to the requester via `deliverChannelReply` on the
 * callback-less `/deliver/<channel>` route — NOT the notification pipeline,
 * which is guardian-facing (`emitNotificationSignal` resolves the *guardian's*
 * delivery channels). The guardian is intentionally left passive here: the
 * withdrawn card already reflects the expired state, so a fresh ping would be
 * noise.
 *
 * Never throws; `complete` reports whether the side effects actually ran,
 * because the sweep confirms a request's expiry (the status CAS) only after
 * they did: a failed notice left the requester untold, so it must keep the
 * row pending and retryable rather than vanish into a log line. A request
 * with no deliverable route or no requester chat reports complete: there is
 * nothing a retry could ever deliver.
 */

import type { GuardianRequestWire } from "../channels/gateway-guardian-requests.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../runtime/assistant-scope.js";
import { deliverChannelReply } from "../runtime/gateway-client.js";
import { introductionMode } from "../runtime/introduction-policy.js";
import * as pendingInteractions from "../runtime/pending-interactions.js";
import { getLogger } from "../util/logger.js";
import {
  resolveDeliverCallbackUrlForChannel,
  resolveRequesterDeliveryTarget,
} from "./guardian-channel-delivery.js";

const log = getLogger("guardian-expiry-notifier");

/**
 * Run the expiry side effects for a single guardian request the sweep is
 * expiring. Dispatches by kind; never throws.
 */
export async function notifyExpiredGuardianRequest(
  request: GuardianRequestWire,
): Promise<{ complete: boolean }> {
  try {
    switch (request.kind) {
      case "tool_approval":
        releaseExpiredInteraction(request);
        return { complete: true };
      case "access_request":
        // Admitted-mode nudges expire silently for the requester — the
        // sender made no request and keeps whatever access the floor grants.
        if (!introductionMode(request.requestTrigger).notifyRequesterOnExpiry) {
          return { complete: true };
        }
        return notifyRequesterOfExpiry(
          request,
          "Your access request expired before it was reviewed. " +
            "Send a new message if you still need access.",
        );
      case "tool_grant_request":
        return notifyRequesterOfExpiry(
          request,
          `Your request to use "${request.toolName ?? "a tool"}" expired ` +
            "before it was reviewed. Ask again if you still need it.",
        );
      case "pending_question":
        // Voice call sessions own their own lifecycle and timeout. By the time
        // the request TTL lapses the call is long over and there is no
        // durable requester channel to notify, so there is nothing to do.
        return { complete: true };
      default:
        return { complete: true };
    }
  } catch (err) {
    log.warn(
      { err, requestId: request.id, kind: request.kind },
      "Expiry side effects failed for guardian request (non-fatal)",
    );
    return { complete: false };
  }
}

/**
 * Release the in-memory pending interaction for an expired `tool_approval`.
 *
 * `tool_approval` is the one interaction-bound kind the periodic sweep can
 * reach (it carries a 30-minute `expiresAt`). In practice the request
 * id does not key a *blocking* prompter interaction: PermissionPrompter
 * confirmations are keyed by their own request id with their own (far
 * shorter) timeout, so a `tool_approval` row without a live pending
 * interaction can occur transiently. So this is a safe cleanup: it no-ops
 * when nothing is registered under the request id, and otherwise drops a
 * waiter-less async entry and emits `interaction_resolved` so clients clear
 * the attention indicator. `cancelled` is the documented
 * runtime-termination/timeout outcome.
 */
function releaseExpiredInteraction(request: GuardianRequestWire): void {
  const released = pendingInteractions.resolve(request.id, "cancelled");
  if (released) {
    log.info(
      { requestId: request.id, kind: request.kind },
      "Released pending interaction for expired guardian request",
    );
  }
}

/**
 * Deliver an expiry notice straight to the requester's chat.
 *
 * The sweep is timer-driven and holds no inbound reply callback URL, so this
 * mirrors the resolvers' off-channel (desktop) delivery path: post to the
 * callback-less `/deliver/<channel>` route. On Slack and Discord the notice is
 * routed to the requester's DM via their user id rather than the channel id,
 * so it is never posted into a shared channel (see
 * `resolveRequesterDeliveryTarget`). No-ops on channels without a deliverable
 * route (e.g. email, the in-app vellum surface) or when the requester chat is
 * unknown. Best-effort: a delivery failure is logged, never thrown.
 */
async function notifyRequesterOfExpiry(
  request: GuardianRequestWire,
  text: string,
): Promise<{ complete: boolean }> {
  const channel = request.sourceChannel ?? "";
  const deliverUrl = resolveDeliverCallbackUrlForChannel(channel);
  const requesterChatId =
    request.requesterChatId ?? request.requesterExternalUserId ?? "";
  const requesterExternalUserId = request.requesterExternalUserId ?? "";

  // No deliverable route or no requester chat: nothing a retry could ever
  // deliver, so this counts as complete rather than pinning the request.
  if (!deliverUrl || !requesterChatId) {
    return { complete: true };
  }

  const targetChatId = resolveRequesterDeliveryTarget({
    channel,
    requesterChatId,
    requesterExternalUserId,
  });

  try {
    await deliverChannelReply(deliverUrl, {
      chatId: targetChatId,
      text,
      assistantId: DAEMON_INTERNAL_ASSISTANT_ID,
    });
    log.info(
      { requestId: request.id, kind: request.kind, channel },
      "Notified requester that guardian request expired",
    );
    return { complete: true };
  } catch (err) {
    log.warn(
      { err, requestId: request.id, channel },
      "Failed to notify requester of guardian request expiry (non-fatal)",
    );
    return { complete: false };
  }
}
