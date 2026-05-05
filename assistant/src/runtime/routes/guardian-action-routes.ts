/**
 * Route handlers for deterministic guardian action endpoints.
 *
 * These endpoints let desktop clients fetch pending guardian prompts and
 * submit button decisions without relying on text parsing.
 *
 * All guardian action endpoints require a valid JWT bearer token.
 * Auth is verified upstream by JWT middleware; the adapter injects the
 * actor principal ID via the `x-vellum-actor-principal-id` header.
 *
 * Guardian decisions additionally verify the actor is the bound guardian
 * via the `requireGuardian` route flag.
 */
import { z } from "zod";

import { isHttpAuthDisabled } from "../../config/env.js";
import { findGuardianForChannel } from "../../contacts/contact-store.js";
import {
  type CanonicalGuardianRequest,
  listPendingRequestsByConversationScope,
} from "../../memory/canonical-guardian-store.js";
import { processGuardianDecision } from "../guardian-action-service.js";
import type { GuardianDecisionPrompt } from "../guardian-decision-types.js";
import { buildOneTimeDecisionActions } from "../guardian-decision-types.js";
import { BadRequestError, NotFoundError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

// ---------------------------------------------------------------------------
// GET /v1/guardian-actions/pending?conversationId=...
// ---------------------------------------------------------------------------

function handleGuardianActionsPending({ queryParams = {} }: RouteHandlerArgs) {
  const conversationId = queryParams.conversationId;

  if (!conversationId) {
    throw new BadRequestError("conversationId query parameter is required");
  }

  const prompts = listGuardianDecisionPrompts({
    conversationId,
    channel: "vellum",
  });
  return { conversationId, prompts };
}

// ---------------------------------------------------------------------------
// POST /v1/guardian-actions/decision
// ---------------------------------------------------------------------------

async function handleGuardianActionDecision({
  body,
  headers = {},
}: RouteHandlerArgs) {
  if (!body || typeof body !== "object") {
    throw new BadRequestError("Request body is required");
  }

  const { requestId, action, conversationId } = body as {
    requestId?: string;
    action?: string;
    conversationId?: string;
  };

  if (!requestId || typeof requestId !== "string") {
    throw new BadRequestError("requestId is required");
  }

  if (!action || typeof action !== "string") {
    throw new BadRequestError("action is required");
  }

  // Resolve the actor's guardian principal ID. The HTTP adapter injects it
  // from the AuthContext via the x-vellum-actor-principal-id header.
  // For dev bypass (HTTP auth disabled) the synthetic "dev-bypass" principal
  // won't match the real guardian binding, so fall back to the local guardian
  // binding to avoid identity_mismatch.
  let guardianPrincipalId: string | undefined =
    headers["x-vellum-actor-principal-id"] ?? undefined;
  if (
    isHttpAuthDisabled() &&
    headers["x-vellum-actor-principal-id"] === "dev-bypass"
  ) {
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
    throw new BadRequestError(result.message);
  }
  if (result.applied) {
    return {
      applied: true,
      requestId: result.requestId,
      ...(result.replyText ? { replyText: result.replyText } : {}),
    };
  }
  if (result.reason === "not_found") {
    throw new NotFoundError(
      "No pending guardian action found for this requestId",
    );
  }
  return {
    applied: false,
    reason: result.reason,
    ...(result.resolverFailureReason
      ? { resolverFailureReason: result.resolverFailureReason }
      : {}),
    requestId: result.requestId ?? requestId,
  };
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

function mapCanonicalRequestToPrompt(
  req: CanonicalGuardianRequest,
  conversationId: string,
): GuardianDecisionPrompt {
  const questionText = buildKindAwareQuestionText(req);

  const actions = buildOneTimeDecisionActions();

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
    conversationId,
    callSessionId: req.callSessionId ?? null,
    kind: req.kind,
    commandPreview: req.commandPreview ?? undefined,
    riskLevel: req.riskLevel ?? undefined,
    activityText: req.activityText ?? undefined,
    executionTarget: (req.executionTarget as "sandbox" | "host") ?? undefined,
  };
}

function buildKindAwareQuestionText(req: CanonicalGuardianRequest): string {
  const baseText =
    req.questionText ??
    (req.toolName
      ? req.activityText
        ? `Approve tool: ${req.toolName} — ${req.activityText}`
        : `Approve tool: ${req.toolName}`
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
// Route definitions (shared HTTP + IPC)
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "guardian_actions_pending",
    endpoint: "guardian-actions/pending",
    method: "GET",
    summary: "List pending guardian actions",
    description: "Return pending guardian decision prompts for a conversation.",
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
    handler: handleGuardianActionsPending,
  },
  {
    operationId: "guardian_actions_decision",
    endpoint: "guardian-actions/decision",
    method: "POST",
    requireGuardian: true,
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
    handler: handleGuardianActionDecision,
  },
];
