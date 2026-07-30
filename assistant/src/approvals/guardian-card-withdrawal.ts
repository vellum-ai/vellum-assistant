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
 * It is driven off the gateway's `guardian_request_deliveries` — the
 * per-request registry of where each card was sent — so it stays correct as
 * surfaces are added and is agnostic to which surface originated the decision.
 *
 * Best-effort by contract: the request is already resolved (CAS committed)
 * before this runs, so a failed edit must never surface as a decision failure.
 * Every surface is attempted independently; one failure never blocks the rest.
 */

import {
  type GuardianRequestDeliveryWire,
  type GuardianRequestStatus,
  listGuardianRequestDeliveries,
} from "../channels/gateway-guardian-requests.js";
import { completeSurfaceAndNotify } from "../daemon/conversation-surfaces.js";
import { withdrawSlackApprovalCard } from "../messaging/providers/slack/withdraw.js";
import { approvalCardSurfaceId } from "../notifications/approval-card-data.js";
import {
  type ApprovalAction,
  isParkAction,
  PARK_STATUS_LABEL,
} from "../runtime/channel-approval-types.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("guardian-card-withdrawal");

/** Completion-summary label shown on an in-app card for a resolved request. */
const SURFACE_STATUS_LABELS: Partial<Record<GuardianRequestStatus, string>> = {
  approved: "Approved",
  denied: "Denied",
  expired: "Expired",
  cancelled: "Cancelled",
};

/**
 * The completion-summary label for a resolved card. A `denied` status reached by
 * a park action reads as the neutral {@link PARK_STATUS_LABEL} rather than
 * "Denied" — a parked contact was neither trusted nor kept out.
 */
function resolveStatusLabel(
  status: GuardianRequestStatus,
  decidedAction: ApprovalAction | undefined,
): string {
  if (status === "denied" && isParkAction(decidedAction)) {
    return PARK_STATUS_LABEL;
  }
  return SURFACE_STATUS_LABELS[status] ?? "Resolved";
}

/** The request fields withdrawal reads — structural subset of the wire row. */
export interface WithdrawableGuardianRequest {
  id: string;
  kind: string;
  decidedByExternalUserId: string | null;
  updatedAt: number;
}

export interface WithdrawGuardianCardsParams {
  /** The request, already transitioned to its terminal status. */
  request: WithdrawableGuardianRequest;
  /** Terminal status to reflect on each card. */
  status: GuardianRequestStatus;
  /**
   * Channel the decision originated on, when applicable.
   *
   * The acting in-app client completes its own card optimistically, so the
   * in-app card is skipped when the decision originated in-app; it is withdrawn
   * here only when the decision came from another surface. Omit (e.g. the expiry
   * sweep) to withdraw every surface.
   */
  originChannel?: string;
  /**
   * The action the guardian took, when the terminal status came from a decision
   * (omitted for the expiry sweep). A `denied` status can mean either a neutral
   * park (`leave_unverified`) or an active rejection (`block`/`reject`); the
   * action disambiguates them so a park renders neutrally as
   * {@link PARK_STATUS_LABEL} instead of "Denied".
   */
  decidedAction?: ApprovalAction;
}

/**
 * Withdraw a resolved request's approval cards across all delivery surfaces.
 * Never throws.
 */
export async function withdrawGuardianRequestCards(
  params: WithdrawGuardianCardsParams,
): Promise<void> {
  const { request, status, originChannel, decidedAction } = params;

  let deliveries: GuardianRequestDeliveryWire[];
  try {
    deliveries = await listGuardianRequestDeliveries(request.id);
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
        withdrawVellumCard(
          request,
          delivery,
          status,
          originChannel,
          decidedAction,
        );
      } else if (delivery.destinationChannel === "slack") {
        await withdrawSlackCard(request, delivery, status, decidedAction);
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
  request: WithdrawableGuardianRequest,
  delivery: GuardianRequestDeliveryWire,
  status: GuardianRequestStatus,
  originChannel: string | undefined,
  decidedAction: ApprovalAction | undefined,
): void {
  if (originChannel === "vellum") {
    return;
  }
  if (!delivery.destinationConversationId) {
    return;
  }
  const surfaceId = approvalCardSurfaceId(request.kind, request.id);
  if (!surfaceId) {
    return;
  }
  completeSurfaceAndNotify(
    delivery.destinationConversationId,
    surfaceId,
    resolveStatusLabel(status, decidedAction),
  );
}

/**
 * Edit the Slack message in place to its resolved state — original card content
 * preserved, action buttons removed, an outcome/decider/time line appended.
 * No-ops when the channel-native message id was not captured at delivery time.
 */
async function withdrawSlackCard(
  request: WithdrawableGuardianRequest,
  delivery: GuardianRequestDeliveryWire,
  status: GuardianRequestStatus,
  decidedAction: ApprovalAction | undefined,
): Promise<void> {
  if (!delivery.destinationChatId || !delivery.destinationMessageId) {
    return;
  }
  await withdrawSlackApprovalCard({
    channel: delivery.destinationChatId,
    messageTs: delivery.destinationMessageId,
    status,
    ...(decidedAction ? { decidedAction } : {}),
    decidedByExternalUserId: request.decidedByExternalUserId ?? undefined,
    decidedAtMs: request.updatedAt,
  });
}
