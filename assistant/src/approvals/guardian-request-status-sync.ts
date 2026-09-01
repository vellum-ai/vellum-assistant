/**
 * Terminal status sync for guardian requests resolved outside the decision
 * primitive.
 *
 * Some flows resolve a pending tool confirmation in-memory first and treat
 * that as authoritative: the in-app confirm route and the legacy channel
 * approval rail (`Conversation.handleConfirmationResponse`), and the
 * auto-deny sweeps that supersede confirmations when a new message arrives.
 * Those flows still have to move the gateway's `guardian_requests` row to the
 * matching terminal status so stale "pending" rows can't be matched by later
 * guardian reply routing.
 *
 * A status CAS alone is not enough: the request's approval cards are
 * projected onto every surface it was delivered to (the in-app card, channel
 * messages, and each channel card's paired conversation), and a row that goes
 * terminal without card withdrawal leaves every projection offering live
 * Approve/Reject actions for a decision that already happened (LUM-3489). So
 * the sync runs the same cross-surface withdrawal the decision primitive
 * runs, whenever its CAS is the one that actually landed.
 *
 * First-writer-wins: when the primitive already resolved the request (e.g.
 * the channel approval path decided it and ran withdrawal itself), this CAS
 * misses and no second withdrawal runs.
 *
 * Fire-and-forget by contract: the caller's in-memory resolution is
 * authoritative and often synchronous, so failures are logged, never thrown,
 * and lost syncs are reaped by the orphan sweep.
 *
 * Transitional: this exists for the flows that resolve confirmations
 * in-memory first (the legacy rail). New decision paths must route through
 * `applyGuardianDecision`, which owns the CAS, resolver dispatch, grant
 * minting, and withdrawal together; do not add callers here for anything the
 * pipeline can serve.
 */

import { decideGuardianRequest } from "../channels/gateway-guardian-requests.js";
import type { ApprovalAction } from "../runtime/channel-approval-types.js";
import { getLogger } from "../util/logger.js";
import { withdrawGuardianRequestCards } from "./guardian-card-withdrawal.js";

const log = getLogger("guardian-request-status-sync");

export interface SyncTerminalGuardianRequestStatusParams {
  requestId: string;
  status: "approved" | "denied";
  /** Log line context naming the flow that resolved the confirmation. */
  syncContext: string;
  /**
   * Non-decision cause of the terminal status, threaded through to the
   * feed receipt so an auto-deny reads as what it was (e.g.
   * "superseded") rather than as a rejection the guardian chose.
   */
  terminalReason?: string;
}

/**
 * CAS the gateway request to its terminal status and, when this write is the
 * one that landed, project the outcome onto every delivered approval card.
 *
 * No origin channel is passed to withdrawal: the confirmation flows act on
 * the conversation's confirmation prompt (or on no client at all, for the
 * auto-deny sweeps), never on the approval card itself, so every card
 * projection needs its completion broadcast.
 */
export async function syncTerminalGuardianRequestStatus(
  params: SyncTerminalGuardianRequestStatusParams,
): Promise<void> {
  const { requestId, status, syncContext } = params;
  // The confirmation flows only ever approve or reject, so the resolved
  // cards' action is the plain decision pair derived from the status.
  const decidedAction: ApprovalAction =
    status === "approved" ? "approve_once" : "reject";
  try {
    const decided = await decideGuardianRequest({
      id: requestId,
      expectedStatus: "pending",
      status,
    });
    if (!decided.applied) {
      // The decision primitive (or a concurrent sync) resolved it first and
      // owns the card withdrawal.
      return;
    }
    await withdrawGuardianRequestCards({
      request: decided.request,
      status,
      decidedAction,
      ...(params.terminalReason
        ? { terminalReason: params.terminalReason }
        : {}),
    });
  } catch (err) {
    log.warn(
      { err, requestId, syncContext },
      "Guardian request terminal status sync failed",
    );
  }
}
