/**
 * Expiry side effects for canonical guardian requests.
 *
 * When the canonical expiry sweep transitions a pending request to `expired`,
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
 * Best-effort by contract: the request is already resolved (CAS committed)
 * before this runs, so a failed notice or interaction release must never
 * surface as a sweep failure. Nothing here throws.
 */

import type { CanonicalGuardianRequest } from "../contacts/canonical-guardian-store.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../runtime/assistant-scope.js";
import { deliverChannelReply } from "../runtime/gateway-client.js";
import * as pendingInteractions from "../runtime/pending-interactions.js";
import { getLogger } from "../util/logger.js";
import { resolveDeliverCallbackUrlForChannel } from "./guardian-channel-delivery.js";

const log = getLogger("guardian-expiry-notifier");

/**
 * Run the expiry side effects for a single canonical guardian request that the
 * sweep just transitioned to `expired`. Dispatches by kind; never throws.
 */
export async function notifyExpiredGuardianRequest(
  request: CanonicalGuardianRequest,
): Promise<void> {
  try {
    switch (request.kind) {
      case "tool_approval":
        releaseExpiredInteraction(request);
        return;
      case "access_request":
        await notifyRequesterOfExpiry(
          request,
          "Your access request expired before it was reviewed. " +
            "Send a new message if you still need access.",
        );
        return;
      case "tool_grant_request":
        await notifyRequesterOfExpiry(
          request,
          `Your request to use "${request.toolName ?? "a tool"}" expired ` +
            "before it was reviewed. Ask again if you still need it.",
        );
        return;
      case "pending_question":
        // Voice call sessions own their own lifecycle and timeout. By the time
        // the canonical TTL lapses the call is long over and there is no
        // durable requester channel to notify, so there is nothing to do.
        return;
      default:
        return;
    }
  } catch (err) {
    log.warn(
      { err, requestId: request.id, kind: request.kind },
      "Expiry side effects failed for canonical guardian request (non-fatal)",
    );
  }
}

/**
 * Release the in-memory pending interaction for an expired `tool_approval`.
 *
 * `tool_approval` is the one interaction-bound kind the periodic sweep can
 * reach (it carries a 30-minute `expiresAt`). In practice the canonical request
 * id does not key a *blocking* prompter interaction: ingress escalations — the
 * sole producer of this kind — register no interaction at all, and
 * PermissionPrompter confirmations are keyed by their own request id with their
 * own (far shorter) timeout. So this is a safe cleanup: it no-ops when nothing
 * is registered under the request id, and otherwise drops a waiter-less async
 * entry and emits `interaction_resolved` so clients clear the attention
 * indicator. `cancelled` is the documented runtime-termination/timeout outcome.
 */
function releaseExpiredInteraction(request: CanonicalGuardianRequest): void {
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
 * callback-less `/deliver/<channel>` route. On Slack the notice is routed to
 * the requester's DM via their user id rather than the channel id, so it is
 * never posted into a shared channel. No-ops on channels without a deliverable
 * route (e.g. email, the in-app vellum surface) or when the requester chat is
 * unknown. Best-effort: a delivery failure is logged, never thrown.
 */
async function notifyRequesterOfExpiry(
  request: CanonicalGuardianRequest,
  text: string,
): Promise<void> {
  const channel = request.sourceChannel ?? "";
  const deliverUrl = resolveDeliverCallbackUrlForChannel(channel);
  const requesterChatId =
    request.requesterChatId ?? request.requesterExternalUserId ?? "";
  const requesterExternalUserId = request.requesterExternalUserId ?? "";

  if (!deliverUrl || !requesterChatId) {
    return;
  }

  // On Slack, target the requester's DM (their `U…` user id) instead of the
  // channel id so the expiry notice stays private. Other channels deliver to
  // the requester chat directly.
  const targetChatId =
    channel === "slack" && requesterExternalUserId
      ? requesterExternalUserId
      : requesterChatId;

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
  } catch (err) {
    log.warn(
      { err, requestId: request.id, channel },
      "Failed to notify requester of guardian request expiry (non-fatal)",
    );
  }
}
