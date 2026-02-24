/**
 * Approval conversation turn engine.
 *
 * Processes a single turn of the conversational approval flow by delegating
 * to a generator function (typically backed by a language model) and
 * validating the structured result. Fails closed on any error — returning
 * a safe keep_pending disposition — so that a broken model call never
 * silently approves or rejects a request.
 */

// Hook point: a deterministic classifier could be inserted here as an
// alternative to model-based inference

import type {
  ApprovalConversationContext,
  ApprovalConversationGenerator,
  ApprovalConversationResult,
  ApprovalConversationDisposition,
} from './http-types.js';

const VALID_DISPOSITIONS: ReadonlySet<ApprovalConversationDisposition> = new Set([
  'keep_pending',
  'approve_once',
  'approve_always',
  'reject',
]);

/** Dispositions that represent an actual decision (not just "keep waiting"). */
const DECISION_BEARING_DISPOSITIONS: ReadonlySet<ApprovalConversationDisposition> = new Set([
  'approve_once',
  'approve_always',
  'reject',
]);

const FAIL_CLOSED_REPLY =
  "I couldn't process that. Please reply with approve, deny, or cancel to decide on the pending request.";

function failClosed(): ApprovalConversationResult {
  return { disposition: 'keep_pending', replyText: FAIL_CLOSED_REPLY };
}

function isValidResult(value: unknown): value is ApprovalConversationResult {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.disposition !== 'string') return false;
  if (!VALID_DISPOSITIONS.has(obj.disposition as ApprovalConversationDisposition)) return false;
  if (typeof obj.replyText !== 'string' || obj.replyText.trim().length === 0) return false;
  if (obj.targetRunId !== undefined && typeof obj.targetRunId !== 'string') return false;
  return true;
}

/**
 * Run one turn of the approval conversation engine.
 *
 * Calls the provided generator, validates the result, and returns a
 * structured decision. On ANY failure (timeout, malformed output,
 * exception) the function returns a safe keep_pending fallback.
 */
export async function runApprovalConversationTurn(
  context: ApprovalConversationContext,
  generator: ApprovalConversationGenerator,
): Promise<ApprovalConversationResult> {
  let result: ApprovalConversationResult;

  try {
    result = await generator(context);
  } catch {
    return failClosed();
  }

  if (!isValidResult(result)) {
    return failClosed();
  }

  // Enforce allowed-actions policy: the model must not return a disposition
  // that the caller did not offer (keep_pending is always acceptable).
  if (
    result.disposition !== 'keep_pending'
    && !context.allowedActions.includes(result.disposition)
  ) {
    return failClosed();
  }

  // When multiple approvals are pending and the user is making a decision,
  // targetRunId must be present AND match a known pending approval so a
  // hallucinated or stale ID cannot slip through.
  if (
    context.pendingApprovals.length > 1
    && DECISION_BEARING_DISPOSITIONS.has(result.disposition)
  ) {
    if (!result.targetRunId) return failClosed();
    const validRunIds = new Set(context.pendingApprovals.map((p) => p.runId));
    if (!validRunIds.has(result.targetRunId)) return failClosed();
  }

  return result;
}
