/**
 * Route handlers for standalone approval endpoints.
 *
 * These endpoints resolve pending confirmations, secrets, and trust rules
 * by requestId — orthogonal to message sending.
 *
 * All approval endpoints require a valid JWT via the Authorization: Bearer
 * header. Guardian decisions additionally verify that the actor is the
 * bound guardian.
 */
import { z } from "zod";

import { emitFeedEvent } from "../../home/emit-feed-event.js";
import { getConversationByKey } from "../../memory/conversation-key-store.js";
import type { UserDecision } from "../../permissions/types.js";
import {
  isConversationHostAccessDecision,
  isConversationHostAccessEnablePrompt,
} from "../../permissions/v2-consent-policy.js";
import { getLogger } from "../../util/logger.js";
import { requireBoundGuardian } from "../auth/require-bound-guardian.js";
import type { AuthContext } from "../auth/types.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";
import * as pendingInteractions from "../pending-interactions.js";

const log = getLogger("approval-routes");

function canonicalizeConfirmDecision(params: {
  decision: string;
  interaction: NonNullable<ReturnType<typeof pendingInteractions.get>>;
}): UserDecision | null {
  const { decision } = params;
  if (decision === "allow" || decision === "deny") {
    return decision;
  }
  return null;
}

/**
 * POST /v1/confirm — resolve a pending confirmation by requestId.
 * Requires AuthContext with guardian-bound actor.
 */
export async function handleConfirm(
  req: Request,
  authContext: AuthContext,
): Promise<Response> {
  const authError = requireBoundGuardian(authContext);
  if (authError) return authError;

  const body = (await req.json()) as {
    requestId?: string;
    decision?: string;
    selectedPattern?: string;
    selectedScope?: string;
  };

  const { requestId, selectedPattern, selectedScope } = body;
  const decision = body.decision;

  if (!requestId || typeof requestId !== "string") {
    return httpError("BAD_REQUEST", "requestId is required", 400);
  }

  const peeked = pendingInteractions.get(requestId);
  if (!peeked) {
    log.warn(
      { requestId, decision },
      "Confirmation POST for unknown requestId (already consumed or never registered)",
    );
    return httpError(
      "NOT_FOUND",
      "No pending interaction found for this requestId",
      404,
    );
  }

  const effectiveDecision =
    typeof decision === "string"
      ? canonicalizeConfirmDecision({ decision, interaction: peeked })
      : null;

  if (effectiveDecision == null) {
    return httpError(
      "BAD_REQUEST",
      "decision must resolve to allow or deny",
      400,
    );
  }

  if (
    peeked.confirmationDetails &&
    isConversationHostAccessEnablePrompt(peeked.confirmationDetails) &&
    !isConversationHostAccessDecision(effectiveDecision as UserDecision)
  ) {
    return httpError(
      "FORBIDDEN",
      "Conversation host-access prompts only accept allow or deny",
      403,
    );
  }

  // Validation passed — consume the pending interaction.
  const interaction = pendingInteractions.resolve(requestId)!;

  log.info(
    {
      requestId,
      decision: effectiveDecision,
      toolName: interaction.confirmationDetails?.toolName,
      conversationId: interaction.conversationId,
    },
    "Confirmation resolved via HTTP",
  );

  const approved = effectiveDecision === "allow";
  const toolName = interaction.confirmationDetails?.toolName ?? "unknown tool";
  void emitFeedEvent({
    source: "assistant",
    title: `${approved ? "Approved" : "Denied"} use of ${toolName}.`,
    summary: `${approved ? "Approved" : "Denied"} use of ${toolName}.`,
    dedupKey: `tool-approval:${requestId}`,
    urgency: approved ? undefined : "medium",
    conversationId: interaction.conversationId,
    detailPanel: { kind: "toolPermission" },
  }).catch((err) => {
    log.warn(
      { err, requestId },
      "Failed to emit tool approval resolution feed event",
    );
  });

  // ACP permissions: resolve directly without a Conversation object.
  if (interaction.directResolve) {
    interaction.directResolve(effectiveDecision as UserDecision);
    return Response.json({ accepted: true });
  }

  interaction.conversation!.handleConfirmationResponse(
    requestId,
    effectiveDecision as UserDecision,
    selectedPattern,
    selectedScope,
    undefined,
    {
      source: "button",
    },
  );

  return Response.json({ accepted: true });
}

/**
 * POST /v1/secret — resolve a pending secret request by requestId.
 * Requires AuthContext with guardian-bound actor.
 */
export async function handleSecret(
  req: Request,
  authContext: AuthContext,
): Promise<Response> {
  const authError = requireBoundGuardian(authContext);
  if (authError) return authError;

  const body = (await req.json()) as {
    requestId?: string;
    value?: string;
    delivery?: string;
  };

  const { requestId, value, delivery } = body;

  if (!requestId || typeof requestId !== "string") {
    return httpError("BAD_REQUEST", "requestId is required", 400);
  }

  if (
    delivery !== undefined &&
    delivery !== "store" &&
    delivery !== "transient_send"
  ) {
    return httpError(
      "BAD_REQUEST",
      'delivery must be "store" or "transient_send"',
      400,
    );
  }

  const interaction = pendingInteractions.resolve(requestId);
  if (!interaction) {
    return httpError(
      "NOT_FOUND",
      "No pending interaction found for this requestId",
      404,
    );
  }

  interaction.conversation!.handleSecretResponse(
    requestId,
    value,
    delivery as "store" | "transient_send" | undefined,
  );
  return Response.json({ accepted: true });
}

/**
 * GET /v1/pending-interactions?conversationKey=...
 * Requires AuthContext (already verified upstream by JWT middleware).
 *
 * Returns pending confirmations and secrets for a conversation, allowing
 * polling-based clients (like the CLI) to discover approval requests
 * without SSE.
 */
export function handleListPendingInteractions(
  url: URL,
  _authContext: AuthContext,
): Response {
  // Auth is already verified by JWT middleware upstream — no additional
  // verification needed here. The _authContext parameter is accepted for
  // type consistency and potential future use.
  const conversationKey = url.searchParams.get("conversationKey");
  const conversationId = url.searchParams.get("conversationId");

  let resolvedConversationId: string | undefined;
  if (conversationId) {
    resolvedConversationId = conversationId;
  } else if (conversationKey) {
    const mapping = getConversationByKey(conversationKey);
    resolvedConversationId = mapping?.conversationId;
  } else {
    return httpError(
      "BAD_REQUEST",
      "conversationKey or conversationId query parameter is required",
      400,
    );
  }

  if (!resolvedConversationId) {
    return Response.json({ pendingConfirmation: null, pendingSecret: null });
  }

  const interactions = pendingInteractions.getByConversation(
    resolvedConversationId,
  );

  const confirmation = interactions.find(
    (i) => i.kind === "confirmation" || i.kind === "acp_confirmation",
  );
  const secret = interactions.find((i) => i.kind === "secret");

  return Response.json({
    pendingConfirmation: confirmation
      ? {
          requestId: confirmation.requestId,
          toolName: confirmation.confirmationDetails?.toolName,
          toolUseId: confirmation.requestId,
          input: confirmation.confirmationDetails?.input ?? {},
          riskLevel: confirmation.confirmationDetails?.riskLevel ?? "unknown",
          executionTarget: confirmation.confirmationDetails?.executionTarget,
          allowlistOptions:
            confirmation.confirmationDetails?.allowlistOptions?.map((o) => ({
              label: o.label,
              pattern: o.pattern,
            })),
          scopeOptions: confirmation.confirmationDetails?.scopeOptions,
          persistentDecisionsAllowed:
            confirmation.confirmationDetails?.persistentDecisionsAllowed,
          acpToolKind: confirmation.confirmationDetails?.acpToolKind,
          acpOptions: confirmation.confirmationDetails?.acpOptions,
        }
      : null,
    pendingSecret: secret
      ? {
          requestId: secret.requestId,
        }
      : null,
  });
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function approvalRouteDefinitions(): RouteDefinition[] {
  return [
    {
      endpoint: "confirm",
      method: "POST",
      summary: "Resolve a pending confirmation",
      description: "Approve or deny a pending tool confirmation by requestId.",
      tags: ["approvals"],
      requestBody: z.object({
        requestId: z.string().describe("Pending interaction request ID"),
        decision: z
          .string()
          .describe("One of: allow, deny"),
        selectedPattern: z
          .string()
          .describe("Allowlist pattern for persistent decisions")
          .optional(),
        selectedScope: z
          .string()
          .describe("Scope for persistent decisions")
          .optional(),
      }),
      responseBody: z.object({
        accepted: z.boolean(),
      }),
      handler: async ({ req, authContext }) => handleConfirm(req, authContext),
    },
    {
      endpoint: "secret",
      method: "POST",
      summary: "Resolve a pending secret request",
      description: "Provide a secret value for a pending secret request.",
      tags: ["approvals"],
      requestBody: z.object({
        requestId: z.string().describe("Pending interaction request ID"),
        value: z.string().describe("Secret value").optional(),
        delivery: z
          .string()
          .describe("Delivery mode: store or transient_send")
          .optional(),
      }),
      responseBody: z.object({
        accepted: z.boolean(),
      }),
      handler: async ({ req, authContext }) => handleSecret(req, authContext),
    },
    {
      endpoint: "pending-interactions",
      method: "GET",
      summary: "List pending interactions",
      description:
        "Return pending confirmations and secrets for a conversation.",
      tags: ["approvals"],
      queryParams: [
        {
          name: "conversationKey",
          schema: { type: "string" },
          description: "Conversation key",
        },
        {
          name: "conversationId",
          schema: { type: "string" },
          description: "Conversation ID",
        },
      ],
      responseBody: z.object({
        pendingConfirmation: z
          .object({})
          .passthrough()
          .describe("Pending confirmation details or null"),
        pendingSecret: z
          .object({})
          .passthrough()
          .describe("Pending secret request or null"),
      }),
      handler: ({ url, authContext }) =>
        handleListPendingInteractions(url, authContext),
    },
  ];
}
