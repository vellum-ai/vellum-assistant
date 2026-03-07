/**
 * Proactive guardian approval expiry sweep: periodically checks for expired
 * guardian approvals, auto-denies the underlying requests, and notifies both
 * the requester and guardian.
 */
import {
  getExpiredPendingApprovals,
  updateApprovalDecision,
} from "../../memory/guardian-approvals.js";
import { getLogger } from "../../util/logger.js";
import { composeApprovalMessageGenerative } from "../approval-message-composer.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../assistant-scope.js";
import type { ApprovalDecisionResult } from "../channel-approval-types.js";
import { handleChannelDecision } from "../channel-approvals.js";
import { deliverChannelReply } from "../gateway-client.js";
import type { ApprovalCopyGenerator } from "../http-types.js";

const log = getLogger("runtime-http");

/** Interval at which the expiry sweep runs (60 seconds). */
const GUARDIAN_EXPIRY_SWEEP_INTERVAL_MS = 60_000;

/** Timer handle for the expiry sweep so it can be stopped in tests. */
let expirySweepTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Sweep expired guardian approval requests, auto-deny the underlying requests,
 * and notify both the requester and guardian. This runs proactively on a
 * timer so expired approvals are closed without waiting for follow-up
 * traffic from either party.
 *
 * Accepts a `gatewayBaseUrl` rather than a fixed delivery URL so that
 * each approval's notification is routed to the correct channel-specific
 * endpoint (e.g. `/deliver/telegram`, `/deliver/voice`).
 */
export function sweepExpiredGuardianApprovals(
  gatewayBaseUrl: string,
  mintBearerToken?: () => string,
  approvalCopyGenerator?: ApprovalCopyGenerator,
): void {
  const expired = getExpiredPendingApprovals();
  for (const approval of expired) {
    // Mark the approval as expired
    updateApprovalDecision(approval.id, { status: "expired" });

    // Auto-deny the underlying request via the pending-interactions tracker
    const expiredDecision: ApprovalDecisionResult = {
      action: "reject",
      source: "plain_text",
    };
    handleChannelDecision(approval.conversationId, expiredDecision);

    // Construct the per-channel delivery URL from the approval's channel
    const deliverUrl = `${gatewayBaseUrl}/deliver/${approval.channel}`;

    // Notify the requester that the approval expired
    void (async () => {
      const requesterText = await composeApprovalMessageGenerative(
        {
          scenario: "guardian_expired_requester",
          toolName: approval.toolName,
          channel: approval.channel,
        },
        {},
        approvalCopyGenerator,
      );
      await deliverChannelReply(
        deliverUrl,
        {
          chatId: approval.requesterChatId,
          text: requesterText,
          assistantId: DAEMON_INTERNAL_ASSISTANT_ID,
        },
        mintBearerToken?.(),
      );
    })().catch((err) => {
      log.error(
        { err, approvalId: approval.id },
        "Failed to notify requester of guardian approval expiry",
      );
    });

    // Notify the guardian that the approval expired
    void (async () => {
      const guardianText = await composeApprovalMessageGenerative(
        {
          scenario: "guardian_expired_guardian",
          toolName: approval.toolName,
          requesterIdentifier: approval.requesterExternalUserId,
          channel: approval.channel,
        },
        {},
        approvalCopyGenerator,
      );
      await deliverChannelReply(
        deliverUrl,
        {
          chatId: approval.guardianChatId,
          text: guardianText,
          assistantId: DAEMON_INTERNAL_ASSISTANT_ID,
        },
        mintBearerToken?.(),
      );
    })().catch((err) => {
      log.error(
        { err, approvalId: approval.id },
        "Failed to notify guardian of approval expiry",
      );
    });

    log.info(
      { requestId: approval.requestId, approvalId: approval.id },
      "Auto-denied expired guardian approval request",
    );
  }
}

/**
 * Start the periodic expiry sweep. Idempotent — calling it multiple times
 * re-uses the same timer.
 */
export function startGuardianExpirySweep(
  gatewayBaseUrl: string,
  mintBearerToken?: () => string,
  approvalCopyGenerator?: ApprovalCopyGenerator,
): void {
  if (expirySweepTimer) return;
  expirySweepTimer = setInterval(() => {
    try {
      sweepExpiredGuardianApprovals(
        gatewayBaseUrl,
        mintBearerToken,
        approvalCopyGenerator,
      );
    } catch (err) {
      log.error({ err }, "Guardian expiry sweep failed");
    }
  }, GUARDIAN_EXPIRY_SWEEP_INTERVAL_MS);
}

/**
 * Stop the periodic expiry sweep. Used in tests and shutdown.
 */
export function stopGuardianExpirySweep(): void {
  if (expirySweepTimer) {
    clearInterval(expirySweepTimer);
    expirySweepTimer = null;
  }
}
