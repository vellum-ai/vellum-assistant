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
 * Withdrawal preserves the card's information and removes only the live
 * affordances (it does not delete the message/card) so each surface keeps an
 * audit trail of what was decided.
 *
 * It is driven off `canonical_guardian_deliveries` — the per-request registry of
 * where each card was sent — so it stays correct as surfaces are added and is
 * agnostic to which surface originated the decision.
 *
 * Best-effort by contract: the request is already resolved (CAS committed)
 * before this runs, so a failed edit must never surface as a decision failure.
 * Every surface is attempted independently; one failure never blocks the rest.
 */

import {
  type CanonicalGuardianDelivery,
  type CanonicalGuardianRequest,
  type CanonicalRequestStatus,
  listCanonicalGuardianDeliveries,
} from "../contacts/canonical-guardian-store.js";
import { completeSurfaceAndNotify } from "../daemon/conversation-surfaces.js";
import { withdrawSlackApprovalCard } from "../messaging/providers/slack/withdraw.js";
import { approvalCardSurfaceId } from "../notifications/approval-card-data.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("guardian-card-withdrawal");

/** Completion-summary label shown on an in-app card for a resolved request. */
const SURFACE_STATUS_LABELS: Partial<Record<CanonicalRequestStatus, string>> = {
  approved: "Approved",
  denied: "Denied",
  expired: "Expired",
  cancelled: "Cancelled",
};

export interface WithdrawGuardianCardsParams {
  /** The request, already transitioned to its terminal status. */
  request: CanonicalGuardianRequest;
  /** Terminal status to reflect on each card. */
  status: CanonicalRequestStatus;
  /**
   * Channel the decision originated on, when applicable.
   *
   * The acting in-app client completes its own card optimistically, so the
   * in-app card is skipped when the decision originated in-app; it is withdrawn
   * here only when the decision came from another surface. Omit (e.g. the expiry
   * sweep) to withdraw every surface.
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
      } else if (delivery.destinationChannel === "slack") {
        await withdrawSlackCard(request, delivery, status);
      }
      // Telegram/WhatsApp direct delivery can't edit a message in place (it
      // would post a new one), so their stale clicks are left to the existing
      // "already resolved" reply until in-place edit support lands.
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
 * Withdraw the in-app approval card so it stops offering live actions while
 * keeping its content. Skipped when the decision originated in-app — the acting
 * client already completed the card itself.
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
 * Edit the Slack message in place to its resolved state — original card content
 * preserved, action buttons removed, an outcome/decider/time line appended.
 * No-ops when the channel-native message id was not captured at delivery time.
 */
async function withdrawSlackCard(
  request: CanonicalGuardianRequest,
  delivery: CanonicalGuardianDelivery,
  status: CanonicalRequestStatus,
): Promise<void> {
  if (!delivery.destinationChatId || !delivery.destinationMessageId) return;
  await withdrawSlackApprovalCard({
    channel: delivery.destinationChatId,
    messageTs: delivery.destinationMessageId,
    status,
    decidedByExternalUserId: request.decidedByExternalUserId ?? undefined,
    decidedAtMs: request.updatedAt,
  });
}
