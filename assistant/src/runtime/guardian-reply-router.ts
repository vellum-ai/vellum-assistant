/**
 * Shared guardian reply router for inbound channel messages.
 *
 * Provides a single entry point (`routeGuardianReply`) for all inbound
 * guardian reply processing across Telegram and WhatsApp. Routes
 * through a priority-ordered pipeline:
 *
 *   1. Deterministic callback/ref parsing (button presses with `apr:<requestId>:<action>`)
 *   2. Request code parsing (6-char alphanumeric prefix matching)
 *   3. NL classification via the conversational approval engine
 *
 * All decisions flow through `applyCanonicalGuardianDecision` from M2,
 * which handles identity validation, expiry checks, CAS resolution,
 * kind-specific resolver dispatch, and grant minting.
 *
 * The router is intentionally kept separate from the inbound message handler
 * to allow for incremental migration and independent testability.
 */

import {
  applyCanonicalGuardianDecision,
  type CanonicalDecisionResult,
} from "../approvals/guardian-decision-primitive.js";
import type {
  ActorContext,
  ChannelDeliveryContext,
  ResolverEmissionContext,
} from "../approvals/guardian-request-resolvers.js";
import {
  type CanonicalGuardianRequest,
  getCanonicalGuardianRequest,
  getCanonicalGuardianRequestByCode,
  isRequestExpired,
  listCanonicalGuardianRequests,
} from "../memory/canonical-guardian-store.js";
import {
  buildGuardianCodeOnlyClarification,
  buildGuardianDisambiguationExample,
  buildGuardianDisambiguationLabel,
  buildGuardianInvalidActionReply,
  resolveGuardianInstructionModeForRequest,
} from "../notifications/guardian-question-mode.js";
import { getLogger } from "../util/logger.js";
import { runApprovalConversationTurn } from "./approval-conversation-turn.js";
import type { ApprovalAction } from "./channel-approval-types.js";
import type {
  ApprovalConversationContext,
  ApprovalConversationGenerator,
} from "./http-types.js";

const log = getLogger("guardian-reply-router");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Context for an inbound message that may be a guardian reply. */
export interface GuardianReplyContext {
  /** The raw message text (trimmed). */
  messageText: string;
  /** Source channel (telegram, whatsapp, etc.). */
  channel: string;
  /** Actor identity context for the sender. */
  actor: ActorContext;
  /** Conversation ID for this message (may be the guardian's conversation). */
  conversationId: string;
  /** Callback data from button presses (e.g. `apr:<requestId>:<action>`). */
  callbackData?: string;
  /** IDs of known pending canonical requests for this guardian. */
  pendingRequestIds?: string[];
  /** Conversation generator for NL classification (injected by daemon). */
  approvalConversationGenerator?: ApprovalConversationGenerator;
  /** Optional channel delivery context for resolver-driven side effects. */
  channelDeliveryContext?: ChannelDeliveryContext;
  /** Optional emission context threaded to handleConfirmationResponse for correct source attribution. */
  emissionContext?: ResolverEmissionContext;
}

export type GuardianReplyResultType =
  | "canonical_decision_applied"
  | "canonical_decision_stale"
  | "canonical_resolver_failed"
  | "code_only_clarification"
  | "disambiguation_needed"
  | "nl_keep_pending"
  | "not_consumed";

/** Result from the guardian reply router. */
export interface GuardianReplyResult {
  /** Whether a decision was applied to a canonical request. */
  decisionApplied: boolean;
  /** Reply text to send back to the guardian (if any). */
  replyText?: string;
  /** Whether the message was consumed and should not enter the agent pipeline. */
  consumed: boolean;
  /** The type of outcome for diagnostics. */
  type: GuardianReplyResultType;
  /** The canonical request ID that was targeted (if any). */
  requestId?: string;
  /** Detailed result from the canonical decision primitive (when a decision was attempted). */
  canonicalResult?: CanonicalDecisionResult;
  /**
   * When true, the caller should skip legacy approval interception for this
   * message. Set by the invite handoff bypass so that "open invite flow"
   * reaches the assistant even when other legacy guardian approvals are pending.
   */
  skipApprovalInterception?: boolean;
}

// ---------------------------------------------------------------------------
// Callback data parser — format: "apr:<requestId>:<action>"
// ---------------------------------------------------------------------------

const VALID_ACTIONS: ReadonlySet<string> = new Set([
  "approve_once",
  "approve_10m",
  "approve_thread",
  "approve_always",
  "reject",
]);

interface ParsedCallback {
  requestId: string;
  action: ApprovalAction;
}

function parseCallbackAction(data: string): ParsedCallback | null {
  const parts = data.split(":");
  if (parts.length < 3 || parts[0] !== "apr") return null;
  const requestId = parts[1];
  const action = parts.slice(2).join(":");
  if (!requestId || !VALID_ACTIONS.has(action)) return null;
  return { requestId, action: action as ApprovalAction };
}

// ---------------------------------------------------------------------------
// Request code parser
// ---------------------------------------------------------------------------

/**
 * 6-char alphanumeric request code at the start of a message.
 * Returns the matching canonical request and the remaining text after
 * the code prefix.
 *
 * When `scopeConversationId` is provided, the matched request must belong
 * to that conversation — otherwise the code is treated as unmatched so
 * that requests from other sessions are never accidentally consumed.
 */
interface CodeParseResult {
  request: CanonicalGuardianRequest;
  remainingText: string;
}

function parseRequestCode(
  text: string,
  scopeConversationId?: string,
): CodeParseResult | null {
  // Request codes are 6 hex chars (A-F, 0-9), uppercase
  const upper = text.toUpperCase();
  const match = upper.match(/^([A-F0-9]{6})(?:\s|$)/);
  if (!match) return null;

  const code = match[1];
  const request = getCanonicalGuardianRequestByCode(code);
  if (!request) return null;

  // Scope to the current conversation when requested, so a code belonging
  // to a different session/conversation is not consumed here. Requests with
  // null conversationId are global/unscoped and match any conversation.
  if (
    scopeConversationId &&
    request.conversationId &&
    request.conversationId !== scopeConversationId
  ) {
    log.info(
      {
        event: "router_code_conversation_mismatch",
        code,
        requestId: request.id,
        expected: scopeConversationId,
        actual: request.conversationId,
      },
      "Request code matched a canonical request from a different conversation — ignoring",
    );
    return null;
  }

  const remainingText = text.slice(code.length).trim();
  return { request, remainingText };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Find all pending canonical requests for a guardian actor. */
function findPendingCanonicalRequests(
  actor: ActorContext,
  pendingRequestIds?: string[],
  conversationId?: string,
): CanonicalGuardianRequest[] {
  let results: CanonicalGuardianRequest[];

  // When explicit IDs are provided, look them up directly
  if (pendingRequestIds) {
    if (pendingRequestIds.length === 0) {
      return [];
    }
    results = pendingRequestIds
      .map(getCanonicalGuardianRequest)
      .filter((r): r is CanonicalGuardianRequest => r?.status === "pending");
  } else if (actor.actorExternalUserId) {
    // Query by guardian identity when available
    results = listCanonicalGuardianRequests({
      status: "pending",
      guardianExternalUserId: actor.actorExternalUserId,
    });
  } else if (conversationId) {
    // Actors without an actorExternalUserId: scope by conversationId so the NL
    // path can discover pending requests bound to this conversation.
    // Include guardianPrincipalId filter when available so the guardian only
    // sees requests they are authorized to act on.
    results = listCanonicalGuardianRequests({
      status: "pending",
      conversationId,
      ...(actor.guardianPrincipalId
        ? { guardianPrincipalId: actor.guardianPrincipalId }
        : {}),
    });
  } else if (actor.guardianPrincipalId) {
    // Actors with a guardianPrincipalId but no actorExternalUserId or
    // conversationId: query by principal so desktop sessions can still
    // discover pending guardian work via their bound principal.
    results = listCanonicalGuardianRequests({
      status: "pending",
      guardianPrincipalId: actor.guardianPrincipalId,
    });
  } else {
    return [];
  }

  // Exclude requests that have passed their expiresAt deadline — they can
  // no longer be resolved and should not trigger disambiguation or NL
  // classification.
  return results.filter((r) => !isRequestExpired(r));
}

/** Map an approval action string to the NL engine's allowed actions for guardians. */
function guardianAllowedActions(): ApprovalAction[] {
  return ["approve_once", "reject"];
}

function notConsumed(): GuardianReplyResult {
  return { decisionApplied: false, consumed: false, type: "not_consumed" };
}

// ---------------------------------------------------------------------------
// Core router
// ---------------------------------------------------------------------------

/**
 * Route an inbound guardian reply through the canonical decision pipeline.
 *
 * This is the single entry point for all inbound guardian reply processing.
 * It handles messages from any channel (Telegram, WhatsApp) and
 * routes through priority-ordered matching:
 *
 *   1. Deterministic callback parsing (button presses)
 *   2. Request code parsing (6-char alphanumeric prefix)
 *   3. NL classification via the conversational approval engine
 *
 * All decisions flow through `applyCanonicalGuardianDecision`.
 */
export async function routeGuardianReply(
  ctx: GuardianReplyContext,
): Promise<GuardianReplyResult> {
  const {
    messageText,
    actor,
    conversationId,
    callbackData,
    approvalConversationGenerator,
    channelDeliveryContext,
    emissionContext,
  } = ctx;
  const pendingRequests = findPendingCanonicalRequests(
    actor,
    ctx.pendingRequestIds,
    conversationId,
  );
  const scopedPendingRequestIds =
    ctx.pendingRequestIds && ctx.pendingRequestIds.length > 0
      ? new Set(ctx.pendingRequestIds)
      : null;

  // ── 1. Deterministic callback parsing (button presses) ──
  // No conversationId scoping here — the guardian's reply comes from a
  // different conversation than the requester's. Identity validation in
  // applyCanonicalGuardianDecision is sufficient to prevent unauthorized
  // cross-user decisions.
  if (callbackData) {
    const parsed = parseCallbackAction(callbackData);
    if (parsed) {
      return applyDecision(
        parsed.requestId,
        parsed.action,
        actor,
        undefined,
        channelDeliveryContext,
        emissionContext,
      );
    }
  }

  // ── 2. Request code parsing (6-char alphanumeric prefix) ──
  // No conversationId scoping — same rationale as the callback path above.
  // The guardian's conversation differs from the requester's.
  if (messageText.length > 0) {
    const codeResult = parseRequestCode(messageText);
    if (codeResult) {
      const { request } = codeResult;
      if (scopedPendingRequestIds && !scopedPendingRequestIds.has(request.id)) {
        log.info(
          {
            event: "router_code_out_of_scope",
            requestId: request.id,
            pendingHintCount: scopedPendingRequestIds.size,
          },
          "Request code matched a pending request outside the caller-provided scope; ignoring",
        );
        return notConsumed();
      }

      if (request.status !== "pending") {
        log.info(
          {
            event: "router_code_already_resolved",
            requestId: request.id,
            status: request.status,
          },
          "Request code matched a non-pending canonical request",
        );
        return {
          decisionApplied: false,
          consumed: true,
          type: "canonical_decision_stale",
          requestId: request.id,
          replyText: failureReplyText(
            "already_resolved",
            request.requestCode,
            request,
          ),
        };
      }

      // Code-only messages (no decision text after the code) are treated as
      // clarification inquiries — the guardian may be asking "what is this?"
      // rather than intending to approve. Return helpful context instead of
      // silently defaulting to approve_once.
      if (
        !codeResult.remainingText ||
        codeResult.remainingText.trim().length === 0
      ) {
        // Identity check: only expose request details to the assigned guardian
        // principal. Strict principal equality prevents leaking request details
        // (toolName, questionText) to unauthorized senders.
        if (!actor.guardianPrincipalId) {
          return {
            decisionApplied: false,
            consumed: true,
            type: "code_only_clarification",
            requestId: request.id,
            replyText: "Request not found.",
          };
        }

        if (
          request.guardianPrincipalId &&
          actor.guardianPrincipalId !== request.guardianPrincipalId
        ) {
          log.warn(
            {
              event: "router_code_only_principal_mismatch",
              requestId: request.id,
              expectedPrincipal: request.guardianPrincipalId,
              actualPrincipal: actor.guardianPrincipalId,
            },
            "Code-only clarification blocked: actor principal does not match request principal",
          );
          return {
            decisionApplied: false,
            consumed: true,
            type: "code_only_clarification",
            requestId: request.id,
            replyText: "Request not found.",
          };
        }

        log.info(
          {
            event: "router_code_only_clarification",
            requestId: request.id,
            code: request.requestCode,
          },
          "Code-only message treated as clarification inquiry",
        );
        return {
          decisionApplied: false,
          consumed: true,
          type: "code_only_clarification",
          requestId: request.id,
          replyText: composeCodeOnlyClarification(request),
        };
      }

      // Remaining text present — infer the decision action from it.
      // If the text indicates rejection, use reject; otherwise approve_once.
      const action = inferActionFromText(codeResult.remainingText);

      return applyDecision(
        request.id,
        action,
        actor,
        codeResult.remainingText,
        channelDeliveryContext,
        emissionContext,
      );
    }
  }

  // ── 2.5. Invite handoff bypass for access requests ──
  // When the guardian sends "open invite flow" and there is at least one
  // pending access_request, return not_consumed so the message falls through
  // to the normal assistant turn and can invoke the Contacts skill.
  if (messageText.length > 0 && pendingRequests.length > 0) {
    const normalized = messageText
      .trim()
      .toLowerCase()
      .replace(/[.!?]+$/g, "");
    if (normalized === "open invite flow") {
      const hasAccessRequest = pendingRequests.some(
        (r) => r.kind === "access_request",
      );
      if (hasAccessRequest) {
        log.info(
          {
            event: "router_invite_handoff",
            pendingCount: pendingRequests.length,
          },
          'Guardian sent "open invite flow" with pending access_request — passing through to assistant',
        );
        return {
          consumed: false,
          decisionApplied: false,
          type: "not_consumed" as const,
          skipApprovalInterception: true,
        };
      }
    }
  }

  // ── 2.6. Deterministic plain-text decisions for known pending targets ──
  // Desktop sessions intentionally do not enable NL classification; when the
  // caller has exactly one known pending request and sends an explicit
  // approve/reject phrase ("approve", "yes", "reject", "no"), apply the
  // decision directly instead of falling through to legacy handlers.
  if (messageText.length > 0 && pendingRequests.length > 0) {
    const inferredAction = inferDecisionActionFromFreeText(messageText);
    if (inferredAction) {
      if (pendingRequests.length === 1) {
        return applyDecision(
          pendingRequests[0].id,
          inferredAction,
          actor,
          messageText,
          channelDeliveryContext,
          emissionContext,
        );
      }

      const disambiguationReply = composeDisambiguationReply(pendingRequests);
      return {
        decisionApplied: false,
        consumed: true,
        type: "disambiguation_needed",
        replyText: disambiguationReply,
      };
    }
  }

  // ── 3. NL classification via the conversational approval engine ──
  if (messageText.length > 0 && approvalConversationGenerator) {
    if (pendingRequests.length === 0) {
      return notConsumed();
    }

    // Use all pending requests for the guardian without conversation scoping.
    // Guardian requests for channel/voice flows are created on the requester's
    // conversation, not the guardian's reply thread, so filtering by
    // conversationId would incorrectly drop valid pending requests. Identity-
    // based filtering in findPendingCanonicalRequests already constrains
    // results to the correct guardian.
    const pendingRequestsForClassification = pendingRequests;

    // Build the conversation context for the NL engine
    const engineContext: ApprovalConversationContext = {
      toolName: pendingRequestsForClassification[0].toolName ?? "unknown",
      allowedActions: guardianAllowedActions(),
      role: "guardian",
      pendingApprovals: pendingRequestsForClassification.map((r) => ({
        requestId: r.id,
        toolName: r.toolName ?? "unknown",
      })),
      userMessage: messageText,
    };

    const engineResult = await runApprovalConversationTurn(
      engineContext,
      approvalConversationGenerator,
    );

    if (engineResult.disposition === "keep_pending") {
      // When the engine returns keep_pending with multiple pending requests,
      // this likely means the NL classification understood a decision intent
      // but runApprovalConversationTurn fail-closed because no targetRequestId
      // was provided. In this case, produce a disambiguation reply instead of
      // a generic "I couldn't process that" message.
      if (pendingRequestsForClassification.length > 1) {
        log.info(
          {
            event: "router_nl_disambiguation_needed",
            pendingCount: pendingRequestsForClassification.length,
          },
          "Engine returned keep_pending with multiple pending requests — producing disambiguation",
        );
        const disambiguationReply = composeDisambiguationReply(
          pendingRequestsForClassification,
          undefined,
        );
        return {
          decisionApplied: false,
          consumed: true,
          type: "disambiguation_needed",
          replyText: disambiguationReply,
        };
      }
      return {
        decisionApplied: false,
        replyText: engineResult.replyText,
        consumed: true,
        type: "nl_keep_pending",
      };
    }

    // Decision-bearing disposition from the engine
    let decisionAction = engineResult.disposition as ApprovalAction;

    // Guardians cannot use broad allow modes — the canonical primitive
    // enforces this too, but enforce it here for clarity.
    if (
      decisionAction === "approve_always" ||
      decisionAction === "approve_10m" ||
      decisionAction === "approve_thread"
    ) {
      decisionAction = "approve_once";
    }

    // Resolve the target request
    const targetId =
      engineResult.targetRequestId ??
      (pendingRequestsForClassification.length === 1
        ? pendingRequestsForClassification[0].id
        : undefined);

    if (!targetId) {
      // Multi-pending and engine didn't pick a target — need disambiguation.
      // Fail-closed: never auto-resolve when the target is ambiguous.
      log.info(
        {
          event: "router_nl_disambiguation_needed",
          pendingCount: pendingRequestsForClassification.length,
        },
        "NL engine returned a decision but no target for multi-pending requests",
      );
      const disambiguationReply = composeDisambiguationReply(
        pendingRequestsForClassification,
        engineResult.replyText,
      );
      return {
        decisionApplied: false,
        consumed: true,
        type: "disambiguation_needed",
        replyText: disambiguationReply,
      };
    }

    const result = await applyDecision(
      targetId,
      decisionAction,
      actor,
      messageText,
      channelDeliveryContext,
      emissionContext,
    );

    // Attach the engine's reply text for stale/expired/identity-mismatch cases,
    // but preserve resolver-authored replies (for example verification codes)
    // and explicit resolver-failure text.
    const hasResolverReplyText = Boolean(
      result.canonicalResult?.applied &&
      result.canonicalResult.resolverReplyText,
    );
    if (
      engineResult.replyText &&
      result.type !== "canonical_resolver_failed" &&
      !hasResolverReplyText
    ) {
      result.replyText = engineResult.replyText;
    }

    return result;
  }

  // No matching strategy and no engine — not consumed
  return notConsumed();
}

// ---------------------------------------------------------------------------
// Decision application
// ---------------------------------------------------------------------------

/**
 * Apply a decision to a canonical request through the unified primitive.
 */
async function applyDecision(
  requestId: string,
  action: ApprovalAction,
  actor: ActorContext,
  userText?: string,
  channelDeliveryContext?: ChannelDeliveryContext,
  emissionContext?: ResolverEmissionContext,
): Promise<GuardianReplyResult> {
  const canonicalResult = await applyCanonicalGuardianDecision({
    requestId,
    action,
    actorContext: actor,
    userText,
    channelDeliveryContext,
    emissionContext,
  });

  if (canonicalResult.applied) {
    if (canonicalResult.resolverFailed) {
      log.warn(
        {
          event: "router_resolver_failed",
          requestId,
          action,
          reason: canonicalResult.resolverFailureReason,
        },
        "Guardian reply router: resolver failed to execute side effects",
      );

      return {
        decisionApplied: false,
        consumed: true,
        type: "canonical_resolver_failed",
        replyText: `Decision recorded but could not be completed: ${canonicalResult.resolverFailureReason ?? "unknown error"}. Please try again.`,
        requestId,
        canonicalResult,
      };
    }

    log.info(
      {
        event: "router_decision_applied",
        requestId,
        action,
        grantMinted: canonicalResult.grantMinted,
      },
      "Guardian reply router applied canonical decision",
    );

    return {
      decisionApplied: true,
      consumed: true,
      type: "canonical_decision_applied",
      ...(canonicalResult.resolverReplyText
        ? { replyText: canonicalResult.resolverReplyText }
        : {}),
      requestId,
      canonicalResult,
    };
  }

  log.info(
    {
      event: "router_decision_not_applied",
      requestId,
      action,
      reason: canonicalResult.reason,
    },
    `Guardian reply router: canonical decision not applied (${canonicalResult.reason})`,
  );

  // When the canonical request doesn't exist, allow the message to fall
  // through so the legacy handleApprovalInterception handler can process it.
  if (canonicalResult.reason === "not_found") {
    return notConsumed();
  }

  const request = getCanonicalGuardianRequest(requestId);

  return {
    decisionApplied: false,
    consumed: true,
    type: "canonical_decision_stale",
    requestId,
    canonicalResult,
    replyText: failureReplyText(
      canonicalResult.reason,
      request?.requestCode,
      request ?? undefined,
    ),
  };
}

// ---------------------------------------------------------------------------
// Text-to-action inference
// ---------------------------------------------------------------------------

const CODE_REJECT_PATTERNS = /^(no|deny|reject|decline|cancel|block)\b/i;
const EXPLICIT_APPROVE_PHRASES: ReadonlySet<string> = new Set([
  "approve",
  "approved",
  "approve once",
  "yes",
  "y",
  "allow",
  "go for it",
  "go ahead",
  "proceed",
  "do it",
]);
const EXPLICIT_REJECT_PHRASES: ReadonlySet<string> = new Set([
  "reject",
  "deny",
  "decline",
  "no",
  "n",
  "block",
  "cancel",
]);

function normalizeDecisionPhrase(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ");
}

/**
 * Strict free-text decision parser used when no request code is present.
 * Returns null unless the message starts with an explicit approve/reject cue.
 */
function inferDecisionActionFromFreeText(text: string): ApprovalAction | null {
  const normalized = normalizeDecisionPhrase(text);
  if (!normalized) return null;
  if (EXPLICIT_REJECT_PHRASES.has(normalized)) return "reject";
  if (EXPLICIT_APPROVE_PHRASES.has(normalized)) return "approve_once";
  return null;
}

/**
 * Infer a guardian decision action from free-text after a request code.
 * Defaults to approve_once unless clear rejection language is detected.
 */
function inferActionFromText(text: string): ApprovalAction {
  if (!text || text.trim().length === 0) {
    return "approve_once";
  }

  if (CODE_REJECT_PATTERNS.test(text.trim())) {
    return "reject";
  }

  return "approve_once";
}

function resolveRequestInstructionMode(
  request?: Pick<CanonicalGuardianRequest, "kind" | "toolName"> | null,
): "approval" | "answer" {
  return resolveGuardianInstructionModeForRequest(request);
}

// ---------------------------------------------------------------------------
// Failure reason reply text
// ---------------------------------------------------------------------------

type CanonicalFailureReason =
  | "already_resolved"
  | "identity_mismatch"
  | "invalid_action"
  | "expired";

/**
 * Map a canonical decision failure reason to a distinct, actionable reply
 * so the guardian understands exactly what happened and what to do next.
 */
function failureReplyText(
  reason: CanonicalFailureReason,
  requestCode?: string | null,
  request?: CanonicalGuardianRequest,
): string {
  switch (reason) {
    case "already_resolved":
      return "This request has already been resolved.";
    case "expired":
      return "This request has expired.";
    case "identity_mismatch":
      return "You don't have permission to decide on this request.";
    case "invalid_action":
      return buildGuardianInvalidActionReply(
        resolveRequestInstructionMode(request),
        requestCode ?? undefined,
      );
    default:
      return "I couldn't process that request. Please try again.";
  }
}

// ---------------------------------------------------------------------------
// Code-only clarification
// ---------------------------------------------------------------------------

/**
 * Compose a clarification response when a guardian sends only a request
 * code without any decision text. Provides context about the request and
 * tells the guardian how to approve or reject it.
 */
function composeCodeOnlyClarification(
  request: CanonicalGuardianRequest,
): string {
  const code = request.requestCode ?? "unknown";
  const mode = resolveRequestInstructionMode(request);
  return buildGuardianCodeOnlyClarification(mode, {
    requestCode: code,
    questionText: request.questionText,
    toolName: request.toolName,
  });
}

// ---------------------------------------------------------------------------
// Disambiguation reply
// ---------------------------------------------------------------------------

/**
 * Compose a disambiguation reply that includes concrete decision examples
 * using actual request codes from the pending requests. Always includes
 * explicit instructions so the guardian knows exactly how to proceed.
 */
function composeDisambiguationReply(
  pendingRequests: CanonicalGuardianRequest[],
  engineReplyText?: string,
): string {
  const lines: string[] = [];
  const requestsWithMode = pendingRequests.map((request) => ({
    request,
    mode: resolveRequestInstructionMode(request),
  }));

  if (engineReplyText) {
    lines.push(engineReplyText);
    lines.push("");
  }

  lines.push(
    `You have ${pendingRequests.length} pending requests. Please specify which one:`,
  );

  for (const { request, mode } of requestsWithMode) {
    const toolLabel = buildGuardianDisambiguationLabel(mode, {
      questionText: request.questionText,
      toolName: request.toolName,
    });
    const code = request.requestCode ?? request.id.slice(0, 6).toUpperCase();
    lines.push(`  - ${code}: ${toolLabel}`);
  }

  const questionRequest = requestsWithMode.find(
    ({ mode }) => mode === "answer",
  );
  const decisionRequest = requestsWithMode.find(
    ({ mode }) => mode === "approval",
  );
  lines.push("");
  if (questionRequest) {
    const exampleCode =
      questionRequest.request.requestCode ??
      questionRequest.request.id.slice(0, 6).toUpperCase();
    lines.push(
      buildGuardianDisambiguationExample(questionRequest.mode, exampleCode),
    );
  }
  if (decisionRequest) {
    const exampleCode =
      decisionRequest.request.requestCode ??
      decisionRequest.request.id.slice(0, 6).toUpperCase();
    lines.push(
      buildGuardianDisambiguationExample(decisionRequest.mode, exampleCode),
    );
  }

  return lines.join("\n");
}
