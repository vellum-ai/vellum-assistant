/**
 * Route handlers for deterministic guardian action endpoints.
 *
 * These endpoints let desktop clients fetch pending guardian prompts and
 * submit button decisions without relying on text parsing.
 *
 * All guardian action endpoints require a valid JWT bearer token.
 * Auth is verified upstream by JWT middleware; the AuthContext is
 * threaded through from the HTTP server layer.
 *
 * Guardian decisions additionally verify the actor is the bound guardian
 * via the AuthContext's actorPrincipalId.
 */
import { z } from "zod";

import { isHttpAuthDisabled } from "../../config/env.js";
import { findGuardianForChannel } from "../../contacts/contact-store.js";
import {
  type CanonicalGuardianRequest,
  listPendingRequestsByConversationScope,
} from "../../memory/canonical-guardian-store.js";
import { requireBoundGuardian } from "../auth/require-bound-guardian.js";
import type { AuthContext } from "../auth/types.js";
import { processGuardianDecision } from "../guardian-action-service.js";
import type { GuardianDecisionPrompt } from "../guardian-decision-types.js";
import { buildDecisionActions } from "../guardian-decision-types.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";

// ---------------------------------------------------------------------------
// GET /v1/guardian-actions/pending?conversationId=...
// ---------------------------------------------------------------------------

/**
 * List pending guardian decision prompts for a conversation.
 * Auth is verified upstream by JWT middleware.
 *
 * Returns guardian approval requests (from the channel guardian store) that
 * are still pending, mapped to the GuardianDecisionPrompt shape so clients
 * can render structured button UIs.
 */
export function handleGuardianActionsPending(
  url: URL,
  _authContext: AuthContext,
): Response {
  const conversationId = url.searchParams.get("conversationId");

  if (!conversationId) {
    return httpError(
      "BAD_REQUEST",
      "conversationId query parameter is required",
      400,
    );
  }

  const prompts = listGuardianDecisionPrompts({
    conversationId,
    channel: "vellum",
  });
  return Response.json({ conversationId, prompts });
}

// ---------------------------------------------------------------------------
// POST /v1/guardian-actions/decision
// ---------------------------------------------------------------------------

/**
 * Submit a guardian action decision.
 * Requires AuthContext with a bound guardian actor.
 *
 * Routes all decisions through the unified canonical guardian decision
 * primitive which handles CAS resolution, resolver dispatch, and grant
 * minting.
 */
export async function handleGuardianActionDecision(
  req: Request,
  authContext: AuthContext,
): Promise<Response> {
  const guardianError = requireBoundGuardian(authContext);
  if (guardianError) return guardianError;

  const body = (await req.json()) as {
    requestId?: string;
    action?: string;
    conversationId?: string;
  };

  const { requestId, action, conversationId } = body;

  if (!requestId || typeof requestId !== "string") {
    return httpError("BAD_REQUEST", "requestId is required", 400);
  }

  if (!action || typeof action !== "string") {
    return httpError("BAD_REQUEST", "action is required", 400);
  }

  // Resolve the actor's guardian principal ID. For JWT-verified actors this
  // comes from the token claims. For dev bypass (HTTP auth disabled) the
  // synthetic "dev-bypass" principal won't match the real guardian binding,
  // so fall back to the local guardian binding to avoid identity_mismatch.
  let guardianPrincipalId: string | undefined =
    authContext.actorPrincipalId ?? undefined;
  if (isHttpAuthDisabled() && authContext.actorPrincipalId === "dev-bypass") {
    const binding = findGuardianForChannel("vellum");
    guardianPrincipalId = binding?.contact.principalId ?? undefined;
  }

  const result = await processGuardianDecision({
    requestId,
    action,
    conversationId,
    channel: "vellum",
    actorContext: {
      actorPrincipalId: guardianPrincipalId,
      guardianPrincipalId,
    },
  });

  if (!result.ok) {
    return httpError("BAD_REQUEST", result.message, 400);
  }
  if (result.applied) {
    return Response.json({
      applied: true,
      requestId: result.requestId,
      ...(result.replyText ? { replyText: result.replyText } : {}),
    });
  }
  return result.reason === "not_found"
    ? httpError(
        "NOT_FOUND",
        "No pending guardian action found for this requestId",
        404,
      )
    : Response.json({
        applied: false,
        reason: result.reason,
        ...(result.resolverFailureReason
          ? { resolverFailureReason: result.resolverFailureReason }
          : {}),
        requestId: result.requestId ?? requestId,
      });
}

// ---------------------------------------------------------------------------
// Shared helper: list guardian decision prompts
// ---------------------------------------------------------------------------

/**
 * Build a list of GuardianDecisionPrompt objects for the given conversation.
 *
 * Uses the conversation scope helper to union requests whose source
 * `conversationId` matches AND requests delivered to this conversation.
 * This allows guardian destination conversations (including macOS Vellum conversations)
 * to surface prompts for all canonical kinds.
 *
 * The returned prompts normalize `conversationId` to the queried conversation ID
 * for client rendering stability.
 */
export function listGuardianDecisionPrompts(params: {
  conversationId: string;
  channel?: string;
}): GuardianDecisionPrompt[] {
  const { conversationId, channel } = params;
  const prompts: GuardianDecisionPrompt[] = [];

  const canonicalRequests = listPendingRequestsByConversationScope(
    conversationId,
    channel,
  );

  for (const req of canonicalRequests) {
    // Skip expired canonical requests
    if (req.expiresAt && new Date(req.expiresAt).getTime() < Date.now())
      continue;

    const prompt = mapCanonicalRequestToPrompt(req, conversationId);
    prompts.push(prompt);
  }

  return prompts;
}

// ---------------------------------------------------------------------------
// Canonical request -> prompt mapping
// ---------------------------------------------------------------------------

/**
 * Map a canonical guardian request to the client-facing prompt format.
 *
 * Generates kind-specific questionText and action sets:
 * - `tool_approval`: "Approve tool: <name>" with approve/reject actions
 * - `pending_question`: voice-originated question with approve/reject actions
 * - `access_request`: explicit "Access Request" label with approve/reject actions
 *   and text fallback instructions (request code + "open invite flow")
 *
 * All kinds use `forGuardianOnBehalf: true` (no approve_always) since the
 * guardian is acting on behalf of a requester.
 */
function mapCanonicalRequestToPrompt(
  req: CanonicalGuardianRequest,
  conversationId: string,
): GuardianDecisionPrompt {
  const questionText = buildKindAwareQuestionText(req);

  // All guardian-on-behalf prompts use approve_once + reject only
  // (no approve_always, no temporary modes).
  const actions = buildDecisionActions({ forGuardianOnBehalf: true });

  const expiresAt = req.expiresAt
    ? new Date(req.expiresAt).getTime()
    : Date.now() + 300_000;

  return {
    requestId: req.id,
    requestCode: req.requestCode ?? req.id.slice(0, 6).toUpperCase(),
    state: "pending",
    questionText,
    toolName: req.toolName ?? null,
    actions,
    expiresAt,
    // Normalize to the queried conversation ID for client rendering stability.
    // The canonical request's source conversationId may differ from the
    // guardian destination conversation the client is viewing.
    conversationId,
    callSessionId: req.callSessionId ?? null,
    kind: req.kind,
  };
}

/**
 * Build kind-aware question text for the guardian prompt.
 *
 * For `access_request`, appends deterministic text fallback instructions
 * (request-code approve/reject + "open invite flow") so the prompt remains
 * actionable even when buttons are unavailable or not used.
 */
function buildKindAwareQuestionText(req: CanonicalGuardianRequest): string {
  const baseText =
    req.questionText ??
    (req.toolName
      ? `Approve tool: ${req.toolName}`
      : `Guardian request: ${req.kind}`);

  if (req.kind === "access_request") {
    const code = req.requestCode ?? req.id.slice(0, 6).toUpperCase();
    const lines = [baseText];
    lines.push(
      `\nReply "${code} approve" to grant access or "${code} reject" to deny.`,
    );
    lines.push(
      'Reply "open invite flow" to start Trusted Contacts invite flow.',
    );
    return lines.join("\n");
  }

  return baseText;
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function guardianActionRouteDefinitions(): RouteDefinition[] {
  return [
    {
      endpoint: "guardian-actions/pending",
      method: "GET",
      summary: "List pending guardian actions",
      description:
        "Return pending guardian decision prompts for a conversation.",
      tags: ["guardian"],
      queryParams: [
        {
          name: "conversationId",
          schema: { type: "string" },
          description: "Conversation ID (required)",
        },
      ],
      responseBody: z.object({
        conversationId: z.string(),
        prompts: z
          .array(z.unknown())
          .describe("Guardian decision prompt objects"),
      }),
      handler: ({ url, authContext }) =>
        handleGuardianActionsPending(url, authContext),
    },
    {
      endpoint: "guardian-actions/decision",
      method: "POST",
      summary: "Submit guardian decision",
      description: "Submit a guardian action decision (approve/reject).",
      tags: ["guardian"],
      requestBody: z.object({
        requestId: z.string().describe("Guardian request ID"),
        action: z.string().describe("Decision action"),
        conversationId: z.string().describe("Conversation ID").optional(),
      }),
      responseBody: z.object({
        applied: z.boolean(),
        requestId: z.string(),
        reason: z
          .string()
          .optional()
          .describe("Decline reason (present only when applied is false)"),
        replyText: z
          .string()
          .optional()
          .describe(
            "Resolver reply text for the guardian (e.g. verification code)",
          ),
      }),
      handler: async ({ req, authContext }) =>
        handleGuardianActionDecision(req, authContext),
    },
  ];
}
