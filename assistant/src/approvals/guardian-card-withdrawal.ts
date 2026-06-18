/**
 * Cross-surface withdrawal of guardian approval cards.
 *
 * A single guardian request is projected onto every surface it was delivered
 * to — the in-app Vellum card, a Slack message, etc. When the request reaches a
 * terminal status its cards must stop offering live actions on *all* surfaces,
 * not just the one the guardian acted on. This is the withdrawal counterpart to
 * the unified card *rendering* dispatcher (`notifications/approval-card-data.ts`):
 * rendering projects `pending` onto each surface, withdrawal projects the
 * terminal status back onto each surface.
 *
 * It is driven off `canonical_guardian_deliveries` — the per-request registry of
 * where each card was sent — so it stays correct as surfaces are added and is
 * agnostic to which surface originated the decision.
 *
 * Best-effort by contract: the request is already resolved (CAS committed)
 * before this runs, so a failed edit must never surface as a decision failure.
 * Every surface is attempted independently; one failure never blocks the rest.
 */

import { completeSurfaceAndNotify } from "../daemon/conversation-surfaces.js";
import {
  type CanonicalGuardianDelivery,
  type CanonicalGuardianRequest,
  type CanonicalRequestStatus,
  listCanonicalGuardianDeliveries,
} from "../memory/canonical-guardian-store.js";
import { approvalCardSurfaceId } from "../notifications/approval-card-data.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../runtime/assistant-scope.js";
import { deliverChannelReply } from "../runtime/gateway-client.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("guardian-card-withdrawal");

/** Completion-summary label shown on an in-app card for a resolved request. */
const SURFACE_STATUS_LABELS: Partial<Record<CanonicalRequestStatus, string>> = {
  approved: "Approved",
  denied: "Denied",
  expired: "Expired",
  cancelled: "Cancelled",
};

/** Slack section text (with status glyph) for a resolved card. */
const SLACK_STATUS_TEXT: Partial<Record<CanonicalRequestStatus, string>> = {
  approved: ":white_check_mark: Approved",
  denied: ":x: Denied",
  expired: ":hourglass_done: Expired",
  cancelled: ":no_entry_sign: Cancelled",
};

/**
 * Channels whose delivered card we can edit in place to drop its action
 * buttons. Slack `chat.update` is honoured by the direct-delivery path. Telegram
 * and WhatsApp direct delivery ignore `messageTs` (they would post a *new*
 * message), so their stale clicks are left to the existing "already resolved"
 * reply until in-place edit support lands for them.
 */
const EDITABLE_CHANNELS: ReadonlySet<string> = new Set(["slack"]);

export interface WithdrawGuardianCardsParams {
  /** The request, already transitioned to its terminal status. */
  request: CanonicalGuardianRequest;
  /** Terminal status to reflect on each card. */
  status: CanonicalRequestStatus;
  /**
   * Channel the decision originated on, when applicable.
   *
   * The in-app client completes its own card optimistically on click and shows
   * the resolver's reply text (e.g. a verification code) as the card summary, so
   * re-broadcasting completion for the in-app card would clobber that. The
   * in-app (`vellum`) card is therefore skipped when the decision originated
   * in-app. Channel cards have no optimistic self-update, so they are always
   * withdrawn. Omit (e.g. the expiry sweep) to withdraw every surface.
   */
  originChannel?: string;
}

/**
 * Withdraw a resolved request's approval cards across all delivery surfaces.
 * Never throws.
 */
export async function withdrawGuardianRequestCards(
  params: WithdrawGuardianCardsParams,
): Promise<void> {
  const { request, status, originChannel } = params;

  let deliveries: CanonicalGuardianDelivery[];
  try {
    deliveries = listCanonicalGuardianDeliveries(request.id);
  } catch (err) {
    log.warn(
      { err, requestId: request.id },
      "Failed to list deliveries for card withdrawal",
    );
    return;
  }

  for (const delivery of deliveries) {
    try {
      if (delivery.destinationChannel === "vellum") {
        withdrawVellumCard(request, delivery, status, originChannel);
      } else if (EDITABLE_CHANNELS.has(delivery.destinationChannel)) {
        await withdrawChannelCard(delivery, status);
      }
    } catch (err) {
      log.warn(
        {
          err,
          requestId: request.id,
          channel: delivery.destinationChannel,
        },
        "Failed to withdraw guardian card on surface (non-fatal)",
      );
    }
  }
}

/**
 * Complete the in-app approval card so it stops showing live actions. Skipped
 * when the decision came from in-app — that client already completed the card
 * itself (see {@link WithdrawGuardianCardsParams.originChannel}).
 */
function withdrawVellumCard(
  request: CanonicalGuardianRequest,
  delivery: CanonicalGuardianDelivery,
  status: CanonicalRequestStatus,
  originChannel: string | undefined,
): void {
  if (originChannel === "vellum") return;
  if (!delivery.destinationConversationId) return;
  const surfaceId = approvalCardSurfaceId(request.kind, request.id);
  if (!surfaceId) return;
  completeSurfaceAndNotify(
    delivery.destinationConversationId,
    surfaceId,
    SURFACE_STATUS_LABELS[status] ?? "Resolved",
  );
}

/**
 * Edit an editable-channel message in place to a resolved state with the
 * action buttons removed. No-ops when the channel-native message id was not
 * captured at delivery time.
 */
async function withdrawChannelCard(
  delivery: CanonicalGuardianDelivery,
  status: CanonicalRequestStatus,
): Promise<void> {
  if (!delivery.destinationChatId || !delivery.destinationMessageId) return;

  const text = SLACK_STATUS_TEXT[status] ?? "Resolved";
  await deliverChannelReply(`/deliver/${delivery.destinationChannel}`, {
    chatId: delivery.destinationChatId,
    text,
    blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
    messageTs: delivery.destinationMessageId,
    assistantId: DAEMON_INTERNAL_ASSISTANT_ID,
  });
}
