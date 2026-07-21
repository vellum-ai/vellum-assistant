/**
 * Guardian decision primitive.
 *
 * `applyGuardianDecision` is the single write path for guardian decisions.
 * The gateway owns the `guardian_requests` table; the decision commits
 * through `guardian_requests_decide`, which runs the pending→approved/denied
 * status CAS and the decision's ACL outcome (member activation, unverified
 * seed, channel block, outbound-session mint) in ONE gateway transaction:
 *
 *   1. Request lookup and status validation (gateway read)
 *   2. Principal-based identity authorization
 *   3. Expiry check
 *   4. ACL-outcome planning via the kind's resolver `prepare` hook — BEFORE
 *      any status write
 *   5. Atomic CAS + outcome via `guardian_requests_decide`
 *      (first-writer-wins; a thrown outcome write rolls back the CAS, so the
 *      request stays pending and retryable — no reopen machinery exists)
 *   6. Kind-specific daemon-domain follow-through via the resolver registry
 *   7. Scoped grant minting on approve for requests carrying tool metadata
 *   8. Cross-surface approval-card withdrawal
 *
 * Security invariants enforced here:
 *   - Decision authorization is purely principal-based:
 *     actor.guardianPrincipalId === request.guardianPrincipalId (strict equality)
 *   - Decisions are first-response-wins (gateway CAS stale protection)
 *   - Approve→ACL is atomic: a decision is never committed without its
 *     gateway ACL outcome, and consuming a decision twice never applies two
 *     outcomes
 *   - Valid actions are the `ApprovalAction` union; the introduction-card
 *     actions (trust / verify_code / leave_unverified / block) are scoped to
 *     `access_request` requests only
 *   - Scoped grant minting only on explicit approve for requests with tool metadata
 */

import {
  decideGuardianRequest,
  type DecideGuardianRequestIpcResponse,
  getGuardianRequest,
  type GuardianRequestWire,
} from "../channels/gateway-guardian-requests.js";
import {
  APPROVAL_ACTION_SET,
  type ApprovalAction,
  DENYING_ACTION_SET,
  INTRODUCTION_ACTION_SET,
} from "../runtime/channel-approval-types.js";
import { getLogger } from "../util/logger.js";
import { mintGrantFromDecision } from "./approval-primitive.js";
import { withdrawGuardianRequestCards } from "./guardian-card-withdrawal.js";
import {
  type ActorContext,
  type ChannelDeliveryContext,
  type DecisionOutcomePlan,
  getResolver,
  type ResolverEmissionContext,
} from "./guardian-request-resolvers.js";

const log = getLogger("guardian-decision-primitive");

/** TTL for scoped approval grants minted on guardian approve_once decisions. */
export const GRANT_TTL_MS = 5 * 60 * 1000;

/**
 * Compute the grant `expiresAt` timestamp for a given approval action.
 *
 * All approvals use the default 5-minute TTL.
 */
function computeGrantExpiresAt(_action: ApprovalAction): number {
  return Date.now() + GRANT_TTL_MS;
}

// ---------------------------------------------------------------------------
// Grant minting
// ---------------------------------------------------------------------------

/**
 * Mint a scoped approval grant from a guardian request.
 *
 * Works for all request kinds that carry tool metadata (toolName + inputDigest).
 * Requests without tool metadata are silently skipped — grant minting only
 * applies to tool-approval flows.
 *
 * Fails silently on error — grant minting is best-effort and must never
 * block the approval flow.
 */
export function mintGuardianRequestGrant(params: {
  request: GuardianRequestWire;
  actorChannel: string;
  guardianExternalUserId?: string;
  effectiveAction: ApprovalAction;
}): { minted: boolean } {
  const { request, actorChannel, guardianExternalUserId, effectiveAction } =
    params;

  if (!request.toolName || !request.inputDigest) {
    return { minted: false };
  }

  const result = mintGrantFromDecision({
    scopeMode: "tool_signature",
    toolName: request.toolName,
    inputDigest: request.inputDigest,
    requestChannel: request.sourceChannel ?? "unknown",
    decisionChannel: actorChannel,
    executionChannel: null,
    conversationId: request.sourceConversationId ?? null,
    callSessionId: request.callSessionId ?? null,
    guardianExternalUserId: guardianExternalUserId ?? null,
    requesterExternalUserId: request.requesterExternalUserId ?? null,
    expiresAt: computeGrantExpiresAt(effectiveAction),
  });

  if (result.ok) {
    log.info(
      {
        event: "canonical_grant_minted",
        requestId: request.id,
        toolName: request.toolName,
        conversationId: request.sourceConversationId,
      },
      "Minted scoped approval grant for guardian request",
    );
    return { minted: true };
  }

  log.error(
    {
      event: "canonical_grant_mint_failed",
      reason: result.reason,
      requestId: request.id,
      toolName: request.toolName,
    },
    "Failed to mint scoped approval grant for guardian request (non-fatal)",
  );
  return { minted: false };
}

// ---------------------------------------------------------------------------
// Guardian decision primitive
// ---------------------------------------------------------------------------

/**
 * Valid actions for guardian decisions. The introduction-card actions
 * (`trust` / `verify_code` / `leave_unverified` / `block`) are only valid
 * for `access_request` requests — kind scoping is enforced after the
 * request lookup.
 */
const VALID_DECISION_ACTIONS: ReadonlySet<string> = APPROVAL_ACTION_SET;

export interface ApplyGuardianDecisionParams {
  /** The guardian request ID to resolve. */
  requestId: string;
  /** The decision action. */
  action: ApprovalAction;
  /** Actor context for the entity making the decision. */
  actorContext: ActorContext;
  /** Optional user-supplied text (e.g. answer text for pending questions). */
  userText?: string;
  /** Optional channel delivery context — present when the decision arrived via a channel message. */
  channelDeliveryContext?: ChannelDeliveryContext;
  /** Optional emission context threaded to handleConfirmationResponse for correct source attribution. */
  emissionContext?: ResolverEmissionContext;
}

export type GuardianDecisionResult =
  | {
      applied: true;
      requestId: string;
      grantMinted: boolean;
      resolverFailed?: boolean;
      resolverFailureReason?: string;
      resolverReplyText?: string;
    }
  | {
      applied: false;
      reason:
        | "not_found"
        | "already_resolved"
        | "identity_mismatch"
        | "request_misconfigured"
        | "invalid_action"
        | "expired";
      detail?: string;
    };

/**
 * The failure contract for a decision whose gateway persist did not land (or
 * whose planning aborted it first). The request is still pending gateway-side
 * and the guardian can retry; `resolverFailed` keeps callers on their
 * existing "recorded but not completed — try again" surface.
 */
function decisionPersistFailure(
  requestId: string,
  reason: string,
): GuardianDecisionResult {
  return {
    applied: true,
    requestId,
    grantMinted: false,
    resolverFailed: true,
    resolverFailureReason: reason,
  };
}

/**
 * Apply a guardian decision through the gateway-native request primitive.
 *
 * This is the single write path for all guardian decisions. The status CAS
 * and any ACL outcome commit in one gateway transaction; daemon-domain side
 * effects (pending-interaction resume, call answering, notifications, code
 * delivery, grant minting, card withdrawal) run after the decide returns.
 */
export async function applyGuardianDecision(
  params: ApplyGuardianDecisionParams,
): Promise<GuardianDecisionResult> {
  const {
    requestId,
    action,
    actorContext,
    userText,
    channelDeliveryContext,
    emissionContext,
  } = params;

  // 1. Look up the guardian request
  let request: GuardianRequestWire | null;
  try {
    request = await getGuardianRequest(requestId);
  } catch (err) {
    log.error(
      { err, event: "canonical_decision_lookup_failed", requestId },
      "Guardian request lookup failed (gateway unreachable?)",
    );
    return decisionPersistFailure(requestId, "gateway_unreachable");
  }
  if (!request) {
    log.warn(
      { event: "canonical_decision_not_found", requestId },
      "Guardian request not found",
    );
    return { applied: false, reason: "not_found" };
  }

  // 2a. Validate status is pending
  if (request.status !== "pending") {
    log.info(
      {
        event: "canonical_decision_already_resolved",
        requestId,
        currentStatus: request.status,
      },
      "Guardian request already resolved",
    );
    return { applied: false, reason: "already_resolved" };
  }

  // 2b. Validate action is valid
  if (!VALID_DECISION_ACTIONS.has(action)) {
    log.warn(
      { event: "canonical_decision_invalid_action", requestId, action },
      "Invalid action for guardian decision",
    );
    return {
      applied: false,
      reason: "invalid_action",
      detail: `invalid action: ${action}`,
    };
  }

  // 2b-ii. Introduction-card actions set a contact's trust level and are only
  // meaningful for access requests. Rejecting them for every other kind keeps
  // e.g. a handcrafted `apr:<toolApprovalId>:trust` callback from resolving a
  // tool approval.
  if (
    INTRODUCTION_ACTION_SET.has(action) &&
    request.kind !== "access_request"
  ) {
    log.warn(
      {
        event: "canonical_decision_action_kind_mismatch",
        requestId,
        action,
        kind: request.kind,
      },
      "Introduction-card action rejected for non-access-request kind",
    );
    return {
      applied: false,
      reason: "invalid_action",
      detail: `action ${action} is only valid for access_request`,
    };
  }

  // 2c. Principal-based authorization: actor.guardianPrincipalId must match
  // request.guardianPrincipalId for any applied decision. This is the single
  // authorization gate — principal identity must always match.

  if (!request.guardianPrincipalId) {
    // A decisionable request with no bound principal can never be authorized
    // by anyone — it is stuck. This is a data-integrity fault (creation guards
    // against it for decisionable kinds), not an authorization denial, so it
    // must NOT be reported to the actor as "you don't have permission".
    log.error(
      {
        event: "canonical_decision_missing_request_principal",
        requestId,
        kind: request.kind,
        sourceType: request.sourceType,
      },
      "Guardian request missing guardianPrincipalId; request is undecidable",
    );
    return {
      applied: false,
      reason: "request_misconfigured",
      detail: "request missing guardianPrincipalId",
    };
  }

  if (!actorContext.guardianPrincipalId) {
    log.warn(
      {
        event: "canonical_decision_missing_actor_principal",
        requestId,
        actorChannel: actorContext.channel,
      },
      "Actor missing guardianPrincipalId; rejecting decision",
    );
    return {
      applied: false,
      reason: "identity_mismatch",
      detail: "actor missing guardianPrincipalId",
    };
  }

  if (actorContext.guardianPrincipalId !== request.guardianPrincipalId) {
    log.warn(
      {
        event: "canonical_decision_principal_mismatch",
        requestId,
        expectedPrincipal: request.guardianPrincipalId,
        actualPrincipal: actorContext.guardianPrincipalId,
      },
      "Actor principal does not match request principal",
    );
    return {
      applied: false,
      reason: "identity_mismatch",
      detail: "principal mismatch",
    };
  }

  // 2d. Check expiry
  if (request.expiresAt && request.expiresAt < Date.now()) {
    log.info(
      {
        event: "canonical_decision_expired",
        requestId,
        expiresAt: request.expiresAt,
      },
      "Guardian request has expired",
    );
    return { applied: false, reason: "expired" };
  }

  // 3. Plan the ACL outcome BEFORE any status write. Kinds without a
  // `prepare` hook decide as a plain status CAS.
  const effectiveAction: ApprovalAction = action;
  const targetStatus: "approved" | "denied" = DENYING_ACTION_SET.has(
    effectiveAction,
  )
    ? "denied"
    : "approved";

  const resolver = getResolver(request.kind);
  let plan: DecisionOutcomePlan = {
    ok: true,
    persistFailureReason: "decision_persist_failed",
  };
  if (resolver?.prepare) {
    plan = resolver.prepare({
      request,
      decision: { action: effectiveAction, userText },
      actor: actorContext,
    });
    if (!plan.ok) {
      log.warn(
        {
          event: "canonical_decision_outcome_plan_failed",
          requestId,
          kind: request.kind,
          reason: plan.reason,
        },
        `Decision aborted before any status write: ${plan.reason}`,
      );
      return decisionPersistFailure(requestId, plan.reason);
    }
  }

  // 4. Atomic decide: status CAS + planned ACL outcome in one gateway
  // transaction. A throw means nothing committed — the request is still
  // pending and the guardian can retry; there is nothing to reopen.
  let decided: DecideGuardianRequestIpcResponse;
  try {
    decided = await decideGuardianRequest({
      id: requestId,
      expectedStatus: "pending",
      status: targetStatus,
      ...(userText !== undefined ? { answerText: userText } : {}),
      ...(actorContext.actorExternalUserId !== undefined
        ? { decidedByExternalUserId: actorContext.actorExternalUserId }
        : {}),
      decidedByPrincipalId: actorContext.guardianPrincipalId,
      ...(plan.aclOutcome ? { aclOutcome: plan.aclOutcome } : {}),
    });
  } catch (err) {
    log.error(
      {
        err,
        event: "canonical_decision_persist_failed",
        requestId,
        kind: request.kind,
        action: effectiveAction,
        reason: plan.persistFailureReason,
      },
      "Atomic decide failed; request remains pending and retryable",
    );
    return decisionPersistFailure(requestId, plan.persistFailureReason);
  }

  if (!decided.applied) {
    // CAS miss — someone else resolved it first
    log.info(
      { event: "canonical_decision_cas_failed", requestId },
      "CAS resolution failed (race condition — first writer wins)",
    );
    return { applied: false, reason: "already_resolved" };
  }
  const resolved = decided.request;

  // 5. Dispatch daemon-domain follow-through to the kind-specific resolver.
  // The decision (and its ACL outcome) is already committed; a follow-through
  // failure is surfaced but never rolls anything back.
  let resolverFailed = false;
  let resolverFailureReason: string | undefined;
  let resolverReplyText: string | undefined;
  if (resolver) {
    const resolverResult = await resolver.resolve({
      request: resolved,
      decision: { action: effectiveAction, userText },
      actor: actorContext,
      channelDeliveryContext,
      emissionContext,
      ...(decided.mintedSession ? { mintedSession: decided.mintedSession } : {}),
    });

    if (!resolverResult.ok) {
      log.warn(
        {
          event: "canonical_decision_resolver_failed",
          requestId,
          kind: request.kind,
          reason: resolverResult.reason,
        },
        `Resolver for kind '${request.kind}' failed: ${resolverResult.reason}`,
      );
      // The committed decide stands. Grant minting is skipped on failure so
      // the tool never executes without the intended resolver action (e.g.
      // answerCall) having succeeded.
      resolverFailed = true;
      resolverFailureReason = resolverResult.reason;
    } else {
      resolverReplyText = resolverResult.guardianReplyText;
    }
  } else {
    log.info(
      {
        event: "canonical_decision_no_resolver",
        requestId,
        kind: request.kind,
      },
      `No resolver registered for kind '${request.kind}' — CAS resolution only`,
    );
  }

  // 6. Mint grant if the decision is an approval with tool metadata.
  // Skip when the resolver failed — minting a grant on a failed side effect
  // would allow the tool to execute without the intended resolver action
  // (e.g. answerCall) having succeeded.
  let grantMinted = false;
  if (targetStatus === "approved" && !resolverFailed) {
    const grantResult = mintGuardianRequestGrant({
      request: resolved,
      actorChannel: actorContext.channel,
      guardianExternalUserId:
        actorContext.actorExternalUserId ??
        resolved.guardianExternalUserId ??
        undefined,
      effectiveAction,
    });
    grantMinted = grantResult.minted;
  }

  // 7. Project the terminal status onto the request's approval cards on every
  // surface it was delivered to (in-app, Slack, ...). Fire-and-forget: the
  // decision is already committed and withdrawal is a best-effort cosmetic
  // projection, so awaiting its Slack round-trips would only add latency to
  // the decision response that interactive callers wait on. The projector
  // never throws; the `.catch` is a defensive backstop.
  void withdrawGuardianRequestCards({
    request: resolved,
    status: targetStatus,
    originChannel: actorContext.channel,
  }).catch((err) => {
    log.warn(
      { err, requestId },
      "Cross-surface card withdrawal failed (non-fatal)",
    );
  });

  log.info(
    {
      event: "canonical_decision_applied",
      requestId,
      kind: request.kind,
      action: effectiveAction,
      targetStatus,
      grantMinted,
      resolverFailed,
    },
    resolverFailed
      ? "Guardian decision applied (atomic decide committed) but follow-through failed"
      : "Guardian decision applied successfully",
  );

  return {
    applied: true,
    requestId,
    grantMinted,
    ...(resolverFailed ? { resolverFailed, resolverFailureReason } : {}),
    ...(resolverReplyText ? { resolverReplyText } : {}),
  };
}
