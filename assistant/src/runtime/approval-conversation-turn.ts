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
  ApprovalConversationDisposition,
  ApprovalConversationGenerator,
  ApprovalConversationResult,
} from "./http-types.js";

const VALID_DISPOSITIONS: ReadonlySet<ApprovalConversationDisposition> =
  new Set([
    "keep_pending",
    "approve_once",
    "approve_10m",
    "approve_conversation",
    "approve_always",
    "reject",
  ]);

/** Dispositions that represent an actual decision (not just "keep waiting"). */
const DECISION_BEARING_DISPOSITIONS: ReadonlySet<ApprovalConversationDisposition> =
  new Set([
    "approve_once",
    "approve_10m",
    "approve_conversation",
    "approve_always",
    "reject",
  ]);

const FAIL_CLOSED_REPLY =
  "I couldn't process that. Please reply with approve, deny, or cancel to decide on the pending request.";

function failClosed(): ApprovalConversationResult {
  return { disposition: "keep_pending", replyText: FAIL_CLOSED_REPLY };
}

function isValidResult(value: unknown): value is ApprovalConversationResult {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.disposition !== "string") return false;
  if (
    !VALID_DISPOSITIONS.has(obj.disposition as ApprovalConversationDisposition)
  )
    return false;
  if (typeof obj.replyText !== "string" || obj.replyText.trim().length === 0)
    return false;
  if (
    obj.targetRequestId !== undefined &&
    typeof obj.targetRequestId !== "string"
  )
    return false;
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
    result.disposition !== "keep_pending" &&
    !context.allowedActions.includes(result.disposition)
  ) {
    return failClosed();
  }

  // Validate targetRequestId for decision-bearing dispositions:
  // 1. When multiple approvals are pending, targetRequestId is required.
  // 2. When targetRequestId is present, it must match a known pending approval
  //    regardless of how many approvals are pending.
  if (DECISION_BEARING_DISPOSITIONS.has(result.disposition)) {
    if (context.pendingApprovals.length > 1 && !result.targetRequestId)
      return failClosed();
    if (result.targetRequestId) {
      const validRequestIds = new Set(
        context.pendingApprovals.map((p) => p.requestId),
      );
      if (!validRequestIds.has(result.targetRequestId)) return failClosed();
    }
  }

  return result;
}
