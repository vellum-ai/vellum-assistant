/**
 * Unified guardian decision primitive.
 *
 * All guardian decision entrypoints (callback buttons, conversational engine,
 * legacy parser, requester self-cancel) call through this module instead of
 * inlining the decision-application logic.  This centralizes:
 *
 *   1. `approve_always` downgrade for guardian-on-behalf requests (time-bounded
 *      modes like `approve_10m` and `approve_conversation` are preserved)
 *   2. Identity validation (actor must match assigned guardian)
 *   3. Approval-info capture before the pending interaction is consumed
 *   4. Atomic decision application via `handleChannelDecision`
 *   5. Guardian approval record update
 *   6. Scoped grant minting on approve
 *
 * The canonical path (`applyCanonicalGuardianDecision`) adds:
 *   7. Canonical request lookup and status validation
 *   8. CAS resolution via `resolveCanonicalGuardianRequest`
 *   9. Kind-specific resolver dispatch via the resolver registry
 *
 * Security invariants enforced here:
 *   - Decision authorization is purely principal-based:
 *     actor.guardianPrincipalId === request.guardianPrincipalId (strict equality)
 *   - Decisions are first-response-wins (CAS-like stale protection)
 *   - `approve_always` is downgraded to `approve_once` for guardian-on-behalf
 *     requests; time-bounded modes (`approve_10m`, `approve_conversation`) are
 *     preserved since grants are scoped via `scopeMode: "tool_signature"`
 *   - Scoped grant minting only on explicit approve for requests with tool metadata
 */

import type { ChannelId } from "../channels/types.js";
import {
  type CanonicalGuardianRequest,
  type CanonicalRequestStatus,
  getCanonicalGuardianRequest,
  resolveCanonicalGuardianRequest,
} from "../memory/canonical-guardian-store.js";
import {
  type GuardianApprovalRequest,
  updateApprovalDecision,
} from "../memory/guardian-approvals.js";
import type {
  ApprovalAction,
  ApprovalDecisionResult,
} from "../runtime/channel-approval-types.js";
import {
  getApprovalInfoByConversation,
  handleChannelDecision,
  type PendingApprovalInfo,
} from "../runtime/channel-approvals.js";
import type { ApplyGuardianDecisionResult } from "../runtime/guardian-decision-types.js";
import { computeToolApprovalDigest } from "../security/tool-approval-digest.js";
import { getLogger } from "../util/logger.js";
import { mintGrantFromDecision } from "./approval-primitive.js";
import {
  type ActorContext,
  type ChannelDeliveryContext,
  getResolver,
  type ResolverEmissionContext,
} from "./guardian-request-resolvers.js";

const log = getLogger("guardian-decision-primitive");

/** TTL for scoped approval grants minted on guardian approve_once decisions. */
export const GRANT_TTL_MS = 5 * 60 * 1000;

/** TTL for scoped approval grants minted on guardian approve_10m decisions. */
export const GRANT_TTL_10M_MS = 10 * 60 * 1000;

/**
 * Compute the grant `expiresAt` timestamp for a given approval action.
 *
 * - `approve_10m` → 10 minutes from now
 * - `approve_conversation` → no wall-clock expiry (far-future sentinel;
 *   conversation lifecycle manages cleanup)
 * - All others (`approve_once`, etc.) → 5 minutes from now (default)
 */
export function computeGrantExpiresAt(action: ApprovalAction): number {
  switch (action) {
    case "approve_10m":
      return Date.now() + GRANT_TTL_10M_MS;
    case "approve_conversation":
      return Number.MAX_SAFE_INTEGER;
    default:
      return Date.now() + GRANT_TTL_MS;
  }
}

// ---------------------------------------------------------------------------
// Scoped grant minting
// ---------------------------------------------------------------------------

/**
 * Mint a `tool_signature` scoped grant when a guardian approves a tool-approval
 * request.  Only mints when the approval info contains a tool invocation with
 * input (so we can compute the input digest).  Informational ASK_GUARDIAN
 * requests that lack tool input are skipped.
 *
 * Fails silently on error -- grant minting is best-effort and must never block
 * the approval flow.
 */
export function tryMintToolApprovalGrant(params: {
  approvalInfo: PendingApprovalInfo;
  approval: GuardianApprovalRequest;
  decisionChannel: ChannelId;
  guardianExternalUserId: string;
  effectiveAction: ApprovalAction;
}): void {
  const {
    approvalInfo,
    approval,
    decisionChannel,
    guardianExternalUserId,
    effectiveAction,
  } = params;

  if (!approvalInfo.toolName) {
    return;
  }

  let inputDigest: string;
  try {
    inputDigest = computeToolApprovalDigest(
      approvalInfo.toolName,
      approvalInfo.input,
    );
  } catch (err) {
    log.error(
      {
        err,
        toolName: approvalInfo.toolName,
        conversationId: approval.conversationId,
      },
      "Failed to compute tool approval digest for grant minting (non-fatal)",
    );
    return;
  }

  const result = mintGrantFromDecision({
    scopeMode: "tool_signature",
    toolName: approvalInfo.toolName,
    inputDigest,
    requestChannel: approval.channel,
    decisionChannel,
    executionChannel: null,
    conversationId: approval.conversationId,
    callSessionId: null,
    guardianExternalUserId,
    requesterExternalUserId: approval.requesterExternalUserId,
    expiresAt: computeGrantExpiresAt(effectiveAction),
  });

  if (result.ok) {
    log.info(
      {
        toolName: approvalInfo.toolName,
        conversationId: approval.conversationId,
      },
      "Minted scoped approval grant for guardian tool-approval decision",
    );
  } else {
    log.error(
      {
        reason: result.reason,
        toolName: approvalInfo.toolName,
        conversationId: approval.conversationId,
      },
      "Failed to mint scoped approval grant (non-fatal)",
    );
  }
}

// ---------------------------------------------------------------------------
// Apply guardian decision (unified primitive)
// ---------------------------------------------------------------------------

export interface ApplyGuardianDecisionParams {
  /** The guardian approval record from the store. */
  approval: GuardianApprovalRequest;
  /** The parsed decision (action + source + optional requestId). */
  decision: ApprovalDecisionResult;
  /** Principal ID of the actor making the decision (undefined in callback/interception paths without JWT/auth context). */
  actorPrincipalId: string | undefined;
  /** Channel-native external user ID of the deciding actor (Telegram user ID, phone, etc.). */
  actorExternalUserId: string | undefined;
  /** Channel the decision arrived on. */
  actorChannel: ChannelId;
  /** Optional decision context passed to handleChannelDecision. */
  decisionContext?: string;
}

/**
 * Apply a guardian decision through the unified primitive.
 *
 * This function centralizes the core logic that was previously duplicated
 * across callback, conversational engine, legacy parser, and requester
 * self-cancel paths:
 *
 *   1. Downgrade `approve_always` to `approve_once` (guardians cannot
 *      permanently allowlist tools on behalf of requesters). Time-bounded
 *      modes (`approve_10m`, `approve_conversation`) are preserved.
 *   2. Capture pending approval info before resolution
 *   3. Apply the decision atomically via `handleChannelDecision`
 *   4. Update the guardian approval record
 *   5. Mint a scoped grant on approve
 *
 * Returns a structured result so callers can handle stale/race outcomes.
 */
export function applyGuardianDecision(
  params: ApplyGuardianDecisionParams,
): ApplyGuardianDecisionResult {
  const {
    approval,
    decision,
    actorPrincipalId,
    actorExternalUserId,
    actorChannel,
    decisionContext,
  } = params;

  // Guardians cannot grant permanent allow modes on behalf of requesters.
  // Time-bounded modes (approve_10m, approve_conversation) are safe because
  // grants are scoped to the tool+input signature via scopeMode: "tool_signature".
  const effectiveDecision: ApprovalDecisionResult =
    decision.action === "approve_always"
      ? { ...decision, action: "approve_once" }
      : decision;

  // Capture pending approval info before handleChannelDecision resolves
  // (and removes) the pending interaction. Needed for grant minting.
  const approvalInfo = getApprovalInfoByConversation(approval.conversationId);
  const matchedInfo = effectiveDecision.requestId
    ? approvalInfo.find((a) => a.requestId === effectiveDecision.requestId)
    : approvalInfo[0];

  // Apply the decision to the underlying session
  const result = handleChannelDecision(
    approval.conversationId,
    effectiveDecision,
    decisionContext,
  );

  if (!result.applied) {
    return {
      applied: false,
      reason: "stale",
      requestId: effectiveDecision.requestId,
    };
  }

  // Update the guardian approval request record
  const approvalStatus =
    effectiveDecision.action === "reject"
      ? ("denied" as const)
      : ("approved" as const);
  updateApprovalDecision(approval.id, {
    status: approvalStatus,
    decidedByExternalUserId: actorExternalUserId ?? actorPrincipalId,
  });

  // Mint a scoped grant when a guardian approves a tool-approval request.
  // Skip when neither actor identity is available -- minting a grant without
  // a known guardian identity is meaningless (e.g. requester self-cancel).
  const effectiveGuardianId = actorExternalUserId ?? actorPrincipalId;
  if (
    effectiveDecision.action !== "reject" &&
    matchedInfo &&
    effectiveGuardianId
  ) {
    tryMintToolApprovalGrant({
      approvalInfo: matchedInfo,
      approval,
      decisionChannel: actorChannel,
      guardianExternalUserId: effectiveGuardianId,
      effectiveAction: effectiveDecision.action,
    });
  }

  return {
    applied: true,
    requestId: result.requestId,
  };
}

// ---------------------------------------------------------------------------
// Consolidated canonical grant minting
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

/** Valid actions for canonical guardian decisions. */
const VALID_CANONICAL_ACTIONS: ReadonlySet<ApprovalAction> = new Set([
  "approve_once",
  "approve_10m",
  "approve_conversation",
  "approve_always",
  "reject",
]);

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
 *   3. Downgrade `approve_always` to `approve_once` (guardian-on-behalf invariant;
 *      time-bounded modes like `approve_10m`/`approve_conversation` are preserved)
 *   4. CAS resolve the canonical request atomically
 *   5. Dispatch to kind-specific resolver
 *   6. Mint grant if applicable
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

  // 2c. Principal-based authorization: actor.guardianPrincipalId must match
  // request.guardianPrincipalId for any applied decision. This is the single
  // authorization gate — principal identity must always match.

  if (!request.guardianPrincipalId) {
    log.warn(
      {
        event: "canonical_decision_missing_request_principal",
        requestId,
        kind: request.kind,
        sourceType: request.sourceType,
      },
      "Canonical request missing guardianPrincipalId; rejecting decision",
    );
    return {
      applied: false,
      reason: "identity_mismatch",
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

  // 3. Downgrade approve_always to approve_once for guardian-on-behalf requests.
  // Time-bounded modes (approve_10m, approve_conversation) are permitted.
  const effectiveAction: ApprovalAction =
    action === "approve_always" ? "approve_once" : action;

  // 4. CAS resolve: atomically transition from 'pending' to terminal status
  const targetStatus: CanonicalRequestStatus =
    effectiveAction === "reject" ? "denied" : "approved";

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

  // 5. Dispatch to kind-specific resolver
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
      // The canonical request is already resolved (CAS succeeded), so we don't
      // roll back.  Flag the failure and fall through to grant minting so that
      // callers see applied: true (reflecting the committed DB state) while
      // still being informed that the resolver had an issue.
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
  if (effectiveAction !== "reject" && !resolverFailed) {
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
