/**
 * Extracted helpers for delivering generative approval replies (stale notices,
 * identity mismatch notices, reminders, etc.) that were duplicated across
 * guardian-approval-interception.ts.
 */
import type pino from "pino";

import type { ChannelId } from "../../channels/types.js";
import type { ApprovalMessageContext } from "../approval-message-composer.js";
import { composeApprovalMessageGenerative } from "../approval-message-composer.js";
import { deliverChannelReply } from "../gateway-client.js";
import type { ApprovalCopyGenerator } from "../http-types.js";

// ---------------------------------------------------------------------------
// Deduplication for "already resolved" ephemeral messages
// ---------------------------------------------------------------------------

/**
 * Tracks recently sent stale approval notifications to prevent flooding the
 * user when they rapidly click stale approval buttons. Keyed by
 * `${chatId}:${scenario}` with a 30-second TTL per entry.
 */
const recentStaleNotifications = new Set<string>();

/** TTL in milliseconds for dedup entries. Exported for testing. */
export const STALE_DEDUP_TTL_MS = 30_000;

/** Clear the dedup cache. Exported for testing only. */
export function clearStaleNotificationCache(): void {
  recentStaleNotifications.clear();
}

interface DeliverApprovalReplyParams {
  context: ApprovalMessageContext;
  replyCallbackUrl: string;
  chatId: string;
  assistantId: string;
  bearerToken?: string;
  approvalCopyGenerator?: ApprovalCopyGenerator;
  logger: pino.Logger;
  errorLogMessage: string;
  /** Extra fields merged into the pino error context. */
  errorLogContext?: Record<string, unknown>;
}

/**
 * Compose a generative approval message and deliver it as a channel reply.
 * Swallows delivery errors and logs them — callers don't need their own
 * try/catch blocks.
 */
async function deliverApprovalReply(
  params: DeliverApprovalReplyParams,
): Promise<void> {
  const {
    context,
    replyCallbackUrl,
    chatId,
    assistantId,
    bearerToken,
    approvalCopyGenerator,
    logger,
    errorLogMessage,
    errorLogContext,
  } = params;

  try {
    const text = await composeApprovalMessageGenerative(
      context,
      {},
      approvalCopyGenerator,
    );
    await deliverChannelReply(
      replyCallbackUrl,
      { chatId, text, assistantId },
      bearerToken,
    );
  } catch (err) {
    logger.error({ err, ...errorLogContext }, errorLogMessage);
  }
}

// ---------------------------------------------------------------------------
// Stale approval reply
// ---------------------------------------------------------------------------

export interface DeliverStaleApprovalReplyParams {
  scenario: ApprovalMessageContext["scenario"];
  sourceChannel: ChannelId;
  replyCallbackUrl: string;
  chatId: string;
  assistantId: string;
  bearerToken?: string;
  approvalCopyGenerator?: ApprovalCopyGenerator;
  logger: pino.Logger;
  errorLogMessage: string;
  /** Extra context fields (e.g. pendingCount, toolName) forwarded to the message composer. */
  extraContext?: Partial<ApprovalMessageContext>;
  /** Extra fields merged into the pino error context. */
  errorLogContext?: Record<string, unknown>;
}

/**
 * Deliver a stale/already-resolved approval notice to a channel chat.
 * Consolidates the repeated compose + deliver + try/catch pattern.
 *
 * For `approval_already_resolved` scenarios, deduplicates notifications
 * per chat so rapid stale button clicks don't flood the user with
 * repeated ephemeral warnings.
 */
export async function deliverStaleApprovalReply(
  params: DeliverStaleApprovalReplyParams,
): Promise<void> {
  const { scenario, sourceChannel, extraContext, ...rest } = params;

  // Deduplicate "already resolved" ephemeral messages per chat.
  // If the same (chatId, scenario) pair was notified within the TTL, skip.
  if (scenario === "approval_already_resolved") {
    const dedupeKey = `${rest.chatId}:${scenario}`;
    if (recentStaleNotifications.has(dedupeKey)) {
      return;
    }
    recentStaleNotifications.add(dedupeKey);
    setTimeout(() => {
      recentStaleNotifications.delete(dedupeKey);
    }, STALE_DEDUP_TTL_MS);
  }

  await deliverApprovalReply({
    ...rest,
    context: {
      scenario,
      channel: sourceChannel,
      ...extraContext,
    },
  });
}

// ---------------------------------------------------------------------------
// Identity mismatch reply
// ---------------------------------------------------------------------------

export interface DeliverIdentityMismatchReplyParams {
  sourceChannel: ChannelId;
  replyCallbackUrl: string;
  chatId: string;
  assistantId: string;
  bearerToken?: string;
  approvalCopyGenerator?: ApprovalCopyGenerator;
  logger: pino.Logger;
  errorLogMessage: string;
  /** Extra fields merged into the pino error context. */
  errorLogContext?: Record<string, unknown>;
}

/**
 * Deliver a guardian identity mismatch notice. The scenario is always
 * `guardian_identity_mismatch`.
 */
export async function deliverIdentityMismatchReply(
  params: DeliverIdentityMismatchReplyParams,
): Promise<void> {
  const { sourceChannel, ...rest } = params;

  await deliverApprovalReply({
    ...rest,
    context: {
      scenario: "guardian_identity_mismatch",
      channel: sourceChannel,
    },
  });
}
