/**
 * Canonical guardian decision primitive.
 *
 * `applyCanonicalGuardianDecision` is the single write path for guardian
 * decisions. It operates on the `canonical_guardian_requests` table and
 * dispatches to kind-specific resolvers:
 *
 *   1. Canonical request lookup and status validation
 *   2. Principal-based identity authorization
 *   3. Expiry check
 *   4. CAS resolution via `resolveCanonicalGuardianRequest` (first-writer-wins)
 *   5. Kind-specific resolver dispatch via the resolver registry
 *   6. Scoped grant minting on approve for requests carrying tool metadata
 *   7. Cross-surface approval-card withdrawal
 *
 * Security invariants enforced here:
 *   - Decision authorization is purely principal-based:
 *     actor.guardianPrincipalId === request.guardianPrincipalId (strict equality)
 *   - Decisions are first-response-wins (CAS-like stale protection)
 *   - Valid actions are the `ApprovalAction` union; the introduction-card
 *     actions (trust / verify_code / leave_unverified / block) are scoped to
 *     `access_request` requests only
 *   - Scoped grant minting only on explicit approve for requests with tool metadata
 */

import {
  type CanonicalGuardianRequest,
  type CanonicalRequestStatus,
  getCanonicalGuardianRequest,
  resolveCanonicalGuardianRequest,
} from "../contacts/canonical-guardian-store.js";
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
// Canonical grant minting
// ---------------------------------------------------------------------------

/**
 * Mint a scoped approval grant from a canonical guardian request.
 *
 * Works for all request kinds that carry tool metadata (toolName + inputDigest).
 * Requests without tool metadata are silently skipped — grant minting only
 * applies to tool-approval flows.
 *
 * Fails silently on error — grant minting is best-effort and must never
 * block the approval flow.
 */
export function mintCanonicalRequestGrant(params: {
  request: CanonicalGuardianRequest;
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
    conversationId: request.conversationId ?? null,
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
        conversationId: request.conversationId,
      },
      "Minted scoped approval grant for canonical guardian request",
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
    "Failed to mint scoped approval grant for canonical request (non-fatal)",
  );
  return { minted: false };
}

// ---------------------------------------------------------------------------
// Canonical guardian decision primitive
// ---------------------------------------------------------------------------

/**
 * Valid actions for canonical guardian decisions. The introduction-card
 * actions (`trust` / `verify_code` / `leave_unverified` / `block`) are only
 * valid for `access_request` requests — kind scoping is enforced after the
 * request lookup.
 */
const VALID_CANONICAL_ACTIONS: ReadonlySet<string> = APPROVAL_ACTION_SET;

export interface ApplyCanonicalGuardianDecisionParams {
  /** The canonical request ID to resolve. */
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

export type CanonicalDecisionResult =
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
 * Apply a guardian decision through the canonical request primitive.
 *
 * This is the future single write path for all guardian decisions.  It
 * operates on the canonical_guardian_requests table and dispatches to
 * kind-specific resolvers via the resolver registry.
 *
 * Steps:
 *   1. Look up the canonical request by ID
 *   2. Validate: exists, pending status, identity match, valid action
 *   3. CAS resolve the canonical request atomically
 *   4. Dispatch to kind-specific resolver
 *   5. Mint grant if applicable
 */
export async function applyCanonicalGuardianDecision(
  params: ApplyCanonicalGuardianDecisionParams,
): Promise<CanonicalDecisionResult> {
  const {
    requestId,
    action,
    actorContext,
    userText,
    channelDeliveryContext,
    emissionContext,
  } = params;

  // 1. Look up the canonical request
  const request = getCanonicalGuardianRequest(requestId);
  if (!request) {
    log.warn(
      { event: "canonical_decision_not_found", requestId },
      "Canonical request not found",
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
      "Canonical request already resolved",
    );
    return { applied: false, reason: "already_resolved" };
  }

  // 2b. Validate action is valid
  if (!VALID_CANONICAL_ACTIONS.has(action)) {
    log.warn(
      { event: "canonical_decision_invalid_action", requestId, action },
      "Invalid action for canonical decision",
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
      "Canonical request missing guardianPrincipalId; request is undecidable",
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
      "Canonical request has expired",
    );
    return { applied: false, reason: "expired" };
  }

  // 3. CAS resolve: atomically transition from 'pending' to terminal status
  const effectiveAction: ApprovalAction = action;
  const targetStatus: CanonicalRequestStatus = DENYING_ACTION_SET.has(
    effectiveAction,
  )
    ? "denied"
    : "approved";

  const resolved = resolveCanonicalGuardianRequest(requestId, "pending", {
    status: targetStatus,
    answerText: userText,
    decidedByExternalUserId: actorContext.actorExternalUserId,
    decidedByPrincipalId: actorContext.guardianPrincipalId,
  });

  if (!resolved) {
    // CAS failed — someone else resolved it first
    log.info(
      { event: "canonical_decision_cas_failed", requestId },
      "CAS resolution failed (race condition — first writer wins)",
    );
    return { applied: false, reason: "already_resolved" };
  }

  // 4. Dispatch to kind-specific resolver
  let resolverFailed = false;
  let resolverFailureReason: string | undefined;
  let resolverReplyText: string | undefined;
  const resolver = getResolver(request.kind);
  if (resolver) {
    const resolverResult = await resolver.resolve({
      request: resolved,
      decision: { action: effectiveAction, userText },
      actor: actorContext,
      channelDeliveryContext,
      emissionContext,
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
      // The CAS commit stands; the primitive itself never rolls back. A
      // resolver MAY CAS-reopen the request to `pending` when its gateway
      // persist did not land (the access-request trust/block branches do) —
      // grant minting is skipped on failure either way, and the card
      // withdrawal below re-reads the row so a reopened request keeps its
      // live cards. Callers see applied: true (the decision was committed)
      // plus the resolverFailed flag.
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

  // 5. Mint grant if the decision is an approval with tool metadata.
  // Skip when the resolver failed — minting a grant on a failed side effect
  // would allow the tool to execute without the intended resolver action
  // (e.g. answerCall) having succeeded.
  let grantMinted = false;
  if (targetStatus === "approved" && !resolverFailed) {
    const grantResult = mintCanonicalRequestGrant({
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

  // 6. Project the terminal status onto the request's approval cards on every
  // surface it was delivered to (in-app, Slack, ...). Fire-and-forget: the
  // decision is already committed via CAS and withdrawal is a best-effort
  // cosmetic projection, so awaiting its Slack round-trips would only add
  // latency to the decision response that interactive callers wait on. The
  // projector never throws; the `.catch` is a defensive backstop.
  //
  // A failed resolver may have reopened the request to `pending` (an
  // access-request gateway persist that never landed). Withdrawing the cards
  // then would stamp every surface with a terminal status the row no longer
  // has and strip the buttons the guardian needs to retry — so cards are only
  // withdrawn while the row is actually terminal.
  const rowForWithdrawal = resolverFailed
    ? getCanonicalGuardianRequest(requestId)
    : resolved;
  if (rowForWithdrawal && rowForWithdrawal.status !== "pending") {
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
  }

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
      ? "Canonical guardian decision applied (CAS committed) but resolver failed"
      : "Canonical guardian decision applied successfully",
  );

  return {
    applied: true,
    requestId,
    grantMinted,
    ...(resolverFailed ? { resolverFailed, resolverFailureReason } : {}),
    ...(resolverReplyText ? { resolverReplyText } : {}),
  };
}
