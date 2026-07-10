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
 * All decisions flow through `applyGuardianDecision`, which handles identity
 * validation, expiry checks, the atomic gateway CAS+outcome commit,
 * kind-specific resolver dispatch, and grant minting.
 *
 * Routing reads (code lookup, pending discovery, reaction addressing) use the
 * degrading gateway-client variants: an unreachable gateway resolves to "no
 * pending requests", so the message falls through to the normal pipeline
 * instead of failing the inbound turn — decisions themselves still fail
 * loudly inside the primitive.
 *
 * The router is intentionally kept separate from the inbound message handler
 * to allow for incremental migration and independent testability.
 */

import {
  applyGuardianDecision,
  type GuardianDecisionResult,
} from "../approvals/guardian-decision-primitive.js";
import type {
  ActorContext,
  ChannelDeliveryContext,
  ResolverEmissionContext,
} from "../approvals/guardian-request-resolvers.js";
import {
  getGuardianRequestByCodeOrNull,
  getGuardianRequestOrNull,
  getPendingRequestByDestinationMessageOrNull,
  type GuardianRequestWire,
  listGuardianRequestsOrEmpty,
} from "../channels/gateway-guardian-requests.js";
import {
  buildGuardianCodeOnlyClarification,
  buildGuardianDisambiguationExample,
  buildGuardianDisambiguationLabel,
  buildGuardianInvalidActionReply,
  resolveGuardianInstructionModeForRequest,
} from "../notifications/guardian-question-mode.js";
import { getLogger } from "../util/logger.js";
import { runApprovalConversationTurn } from "./approval-conversation-turn.js";
import {
  type ApprovalAction,
  isApprovalAction,
} from "./channel-approval-types.js";
import type {
  ApprovalConversationContext,
  ApprovalConversationGenerator,
} from "./http-types.js";
import { parseReactionCallbackData } from "./routes/channel-route-shared.js";

const log = getLogger("guardian-reply-router");

/** True when a request has passed its `expiresAt` deadline. */
function isRequestExpired(
  request: Pick<GuardianRequestWire, "expiresAt">,
): boolean {
  return Boolean(request.expiresAt && request.expiresAt < Date.now());
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * How to scope a guardian's pending requests when resolving an inbound reply.
 * The three states are mutually exclusive and named so the security-critical
 * `blocked` cannot be confused with the absence of a hint:
 *
 *   - `scoped`: resolve only these request ids, and constrain request-code
 *     routing to this set (delivery-/conversation-scoped hints).
 *   - `blocked`: fail closed — no pending requests and no identity fallback.
 *     The Slack cross-chat guard: a guardian's unrelated message in a chat
 *     where no card was delivered must not resolve a request delivered
 *     elsewhere. Explicit callbacks and request codes still work (they carry
 *     their own request id).
 *   - `identity-fallback`: discover pending requests by guardian identity,
 *     conversation, or principal. The default when no scope is supplied.
 */
export type GuardianPendingScope =
  | { mode: "scoped"; requestIds: string[] }
  | { mode: "blocked" }
  | { mode: "identity-fallback" };

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
  /**
   * For emoji-reaction decisions (`callbackData` of `reaction:<emoji>`): the
   * channel-native id (e.g. Slack `ts`) of the message the reaction was
   * attached to. Used to recover the target request from its delivery record.
   */
  reactedMessageTs?: string;
  /**
   * How to scope this guardian's pending requests (see {@link
   * GuardianPendingScope}). Omitted is equivalent to
   * `{ mode: "identity-fallback" }`.
   */
  pendingScope?: GuardianPendingScope;
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
  /** Detailed result from the decision primitive (when a decision was attempted). */
  canonicalResult?: GuardianDecisionResult;
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

const LEGACY_CALLBACK_MAP: Record<string, string> = {
  approve_10m: "approve_once",
  approve_conversation: "approve_once",
  approve_always: "approve_once",
};

interface ParsedCallback {
  requestId: string;
  action: ApprovalAction;
}

function parseCallbackAction(data: string): ParsedCallback | null {
  const parts = data.split(":");
  if (parts.length < 3 || parts[0] !== "apr") {
    return null;
  }
  const requestId = parts[1];
  const rawAction = parts.slice(2).join(":");
  const action = LEGACY_CALLBACK_MAP[rawAction] ?? rawAction;
  if (!requestId || !isApprovalAction(action)) {
    return null;
  }
  return { requestId, action };
}

// ---------------------------------------------------------------------------
// Request code parser
// ---------------------------------------------------------------------------

/**
 * 6-char alphanumeric request code at the start of a message.
 * Returns the matching pending guardian request and the remaining text after
 * the code prefix.
 */
interface CodeParseResult {
  request: GuardianRequestWire;
  remainingText: string;
}

async function parseRequestCode(text: string): Promise<CodeParseResult | null> {
  // Strip common channel formatting delimiters (backticks, bold, italic,
  // strikethrough) that messaging platforms wrap around inline code.
  const cleaned = text
    .replace(/^[`*_~]+/, "")
    .replace(/[`*_~]+$/, "")
    .replace(/^([A-Fa-f0-9]{6})[`*_~]+/, "$1")
    .trim();
  // Request codes are 6 hex chars (A-F, 0-9), uppercase
  const upper = cleaned.toUpperCase();
  const match = upper.match(/^([A-F0-9]{6})(?:\s|$)/);
  if (!match) {
    return null;
  }

  const code = match[1];
  const request = await getGuardianRequestByCodeOrNull(code);
  if (!request) {
    return null;
  }

  const remainingText = cleaned.slice(code.length).trim();
  return { request, remainingText };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Find all pending guardian requests for a guardian actor. */
async function findPendingGuardianRequests(
  actor: ActorContext,
  scope: GuardianPendingScope,
  conversationId?: string,
): Promise<GuardianRequestWire[]> {
  // `blocked` fails closed: no pending requests and no identity fallback — the
  // Slack cross-chat hijack guard.
  if (scope.mode === "blocked") {
    return [];
  }

  let results: GuardianRequestWire[];

  if (scope.mode === "scoped") {
    // Resolve exactly the supplied ids.
    const rows = await Promise.all(
      scope.requestIds.map((id) => getGuardianRequestOrNull(id)),
    );
    results = rows.filter(
      (r): r is GuardianRequestWire => r?.status === "pending",
    );
  } else if (actor.actorExternalUserId) {
    // identity-fallback: query by guardian identity when available
    results = await listGuardianRequestsOrEmpty({
      status: "pending",
      guardianExternalUserId: actor.actorExternalUserId,
    });
  } else if (conversationId) {
    // identity-fallback without an actorExternalUserId: scope by the source
    // conversation so the NL path can discover pending requests bound to this
    // conversation. Include guardianPrincipalId when available so the
    // guardian only sees requests they are authorized to act on.
    results = await listGuardianRequestsOrEmpty({
      status: "pending",
      sourceConversationId: conversationId,
      ...(actor.guardianPrincipalId
        ? { guardianPrincipalId: actor.guardianPrincipalId }
        : {}),
    });
  } else if (actor.guardianPrincipalId) {
    // identity-fallback by principal: desktop sessions discover pending
    // guardian work via their bound principal.
    results = await listGuardianRequestsOrEmpty({
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
 * All decisions flow through `applyGuardianDecision`.
 */
export async function routeGuardianReply(
  ctx: GuardianReplyContext,
): Promise<GuardianReplyResult> {
  const {
    messageText,
    channel,
    actor,
    conversationId,
    callbackData,
    reactedMessageTs,
    approvalConversationGenerator,
    channelDeliveryContext,
    emissionContext,
  } = ctx;

  // ── 0. Reaction decisions (emoji on a delivered approval card) ──
  // A reaction carries an emoji plus the message it is attached to. Map the
  // emoji to an action and recover the target request from that card's
  // delivery record. Addressing by the reacted message disambiguates precisely
  // even when several cards are pending in the same chat, so — unlike the
  // text/NL paths — no clarification prompt is ever needed. `reaction_removed`
  // never expresses intent and is filtered out before reaching the router.
  if (
    callbackData?.startsWith("reaction:") &&
    !callbackData.startsWith("reaction_removed:")
  ) {
    const reaction = parseReactionCallbackData(callbackData);
    const guardianChatId = channelDeliveryContext?.guardianChatId;
    if (!reaction || !reactedMessageTs || !guardianChatId) {
      // Unknown emoji, or missing addressing context — not an actionable
      // approval reaction. Leave it for the caller to persist as a transcript
      // signal (it must not trigger an agent turn).
      return notConsumed();
    }
    const request = await getPendingRequestByDestinationMessageOrNull(
      channel,
      guardianChatId,
      reactedMessageTs,
    );
    if (!request) {
      // The reacted message is not a known pending approval card (a stray
      // reaction, or one whose request was already resolved). Never approve
      // off an unrecognized message.
      return notConsumed();
    }
    return applyDecision(
      request.id,
      reaction.action,
      actor,
      undefined,
      channelDeliveryContext,
      emissionContext,
    );
  }

  const pendingScope: GuardianPendingScope = ctx.pendingScope ?? {
    mode: "identity-fallback",
  };
  const pendingRequests = await findPendingGuardianRequests(
    actor,
    pendingScope,
    conversationId,
  );
  // Request codes carry their own id, so constrain them only under an explicit
  // scope; under blocked/identity-fallback they still resolve cross-chat.
  const scopedPendingRequestIds =
    pendingScope.mode === "scoped" ? new Set(pendingScope.requestIds) : null;

  // ── 1. Deterministic callback parsing (button presses) ──
  // No conversationId scoping here — the guardian's reply comes from a
  // different conversation than the requester's. Identity validation in
  // applyGuardianDecision is sufficient to prevent unauthorized
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
    const codeResult = await parseRequestCode(messageText);
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
          "Request code matched a non-pending guardian request",
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

      // Remaining text present — infer the decision action from it, using
      // the introduction-card verb set for access requests.
      const action = inferActionFromText(
        codeResult.remainingText,
        request.kind,
      );

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
    // The action is only applied when exactly one request is pending, so the
    // kind-aware verb set is used for that single known target.
    const inferredAction = inferDecisionActionFromFreeText(
      messageText,
      pendingRequests.length === 1 ? pendingRequests[0].kind : undefined,
    );
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
    // conversation, not the guardian's reply conversation, so filtering by
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

    // Decision-bearing disposition from the engine. The engine's allowed
    // actions are a subset of ApprovalAction; an out-of-vocabulary
    // disposition is not consumed as a decision.
    if (!isApprovalAction(engineResult.disposition)) {
      return notConsumed();
    }
    const decisionAction = engineResult.disposition;

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
 * Apply a decision to a guardian request through the unified primitive.
 */
async function applyDecision(
  requestId: string,
  action: ApprovalAction,
  actor: ActorContext,
  userText?: string,
  channelDeliveryContext?: ChannelDeliveryContext,
  emissionContext?: ResolverEmissionContext,
): Promise<GuardianReplyResult> {
  const canonicalResult = await applyGuardianDecision({
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

  // When the guardian request doesn't exist, allow the message to fall
  // through so the legacy handleApprovalInterception handler can process it.
  if (canonicalResult.reason === "not_found") {
    return notConsumed();
  }

  const request = await getGuardianRequestOrNull(requestId);

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
    .replace(/[`*_~]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ");
}

/**
 * Introduction-card phrases recognized without a request code. Checked before
 * the generic reject vocabulary so a bare "block" on an access request maps
 * to the block action (revoke) rather than the weaker leave-unverified
 * outcome.
 */
const EXPLICIT_INTRODUCTION_PHRASES: ReadonlyMap<string, ApprovalAction> =
  new Map([
    ["trust", "trust"],
    ["trust them", "trust"],
    ["verify", "verify_code"],
    ["verify them", "verify_code"],
    ["block", "block"],
    ["block them", "block"],
    ["ban", "block"],
    ["ban them", "block"],
  ]);

/**
 * Strict free-text decision parser used when no request code is present.
 * Returns null unless the message starts with an explicit decision cue.
 *
 * For `access_request` targets the introduction-card verbs are recognized
 * first, and the generic rejection vocabulary maps to `leave_unverified`
 *.
 *
 * Exported for tests.
 */
export function inferDecisionActionFromFreeText(
  text: string,
  requestKind?: string,
): ApprovalAction | null {
  const normalized = normalizeDecisionPhrase(text);
  if (!normalized) {
    return null;
  }
  if (requestKind === "access_request") {
    const introductionAction = EXPLICIT_INTRODUCTION_PHRASES.get(normalized);
    if (introductionAction) {
      return introductionAction;
    }
    if (EXPLICIT_REJECT_PHRASES.has(normalized)) {
      return "leave_unverified";
    }
    if (EXPLICIT_APPROVE_PHRASES.has(normalized)) {
      return "approve_once";
    }
    return null;
  }
  if (EXPLICIT_REJECT_PHRASES.has(normalized)) {
    return "reject";
  }
  if (EXPLICIT_APPROVE_PHRASES.has(normalized)) {
    return "approve_once";
  }
  return null;
}

/**
 * Introduction-card verbs for `access_request` requests. `trust` / `verify` /
 * `block` map to their card actions; the generic reject vocabulary maps to
 * leave-unverified (deny without revoking).
 */
const CODE_TRUST_PATTERNS = /^(trust|trusted)\b/i;
const CODE_VERIFY_PATTERNS = /^(verify|verification|code|handshake)\b/i;
const CODE_BLOCK_PATTERNS = /^(block|ban)\b/i;

/**
 * Infer a guardian decision action from free-text after a request code.
 * Defaults to approve_once unless clear rejection language is detected.
 *
 * For `access_request` requests, the introduction-card verbs (trust / verify
 * / block) are recognized first, and rejection vocabulary maps to
 * `leave_unverified`.
 */
function inferActionFromText(
  text: string,
  requestKind?: string,
): ApprovalAction {
  if (!text || text.trim().length === 0) {
    return "approve_once";
  }
  const trimmed = text.trim();

  if (requestKind === "access_request") {
    if (CODE_BLOCK_PATTERNS.test(trimmed)) {
      return "block";
    }
    if (CODE_TRUST_PATTERNS.test(trimmed)) {
      return "trust";
    }
    if (CODE_VERIFY_PATTERNS.test(trimmed)) {
      return "verify_code";
    }
    if (CODE_REJECT_PATTERNS.test(trimmed)) {
      return "leave_unverified";
    }
    return "approve_once";
  }

  if (CODE_REJECT_PATTERNS.test(trimmed)) {
    return "reject";
  }

  return "approve_once";
}

function resolveRequestInstructionMode(
  request?: Pick<GuardianRequestWire, "kind" | "toolName"> | null,
): "approval" | "answer" {
  return resolveGuardianInstructionModeForRequest(request);
}

// ---------------------------------------------------------------------------
// Failure reason reply text
// ---------------------------------------------------------------------------

type CanonicalFailureReason =
  | "already_resolved"
  | "identity_mismatch"
  | "request_misconfigured"
  | "invalid_action"
  | "expired";

/**
 * Map a canonical decision failure reason to a distinct, actionable reply
 * so the guardian understands exactly what happened and what to do next.
 */
function failureReplyText(
  reason: CanonicalFailureReason,
  requestCode?: string | null,
  request?: GuardianRequestWire,
): string {
  switch (reason) {
    case "already_resolved":
      return "This request has already been resolved.";
    case "expired":
      return "This request has expired.";
    case "identity_mismatch":
      return "You don't have permission to decide on this request.";
    case "request_misconfigured":
      // The actor is authorized; the request record itself is incomplete
      // (e.g. missing its bound principal). Do not imply a permission problem.
      return "Something went wrong with this request on our end, so I couldn't apply your decision.";
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
  request: GuardianRequestWire,
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
  pendingRequests: GuardianRequestWire[],
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
