/**
 * Route handlers for standalone approval endpoints.
 *
 * These endpoints resolve pending confirmations, secrets, and trust rules
 * by requestId — orthogonal to message sending.
 *
 * Auth is enforced at the transport layer (HTTP policy middleware, IPC
 * socket trust) — handlers contain only business logic.
 */
import { z } from "zod";

import { findConversation } from "../../daemon/conversation-store.js";
import { emitFeedEvent } from "../../home/emit-feed-event.js";
import { getConversationByKey } from "../../memory/conversation-key-store.js";
import type { UserDecision } from "../../permissions/types.js";
import { getLogger } from "../../util/logger.js";
import * as pendingInteractions from "../pending-interactions.js";
import { BadRequestError, NotFoundError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

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
 */
function handleConfirm({ body }: RouteHandlerArgs) {
  const requestId = body?.requestId as string | undefined;
  const decision = body?.decision as string | undefined;
  const selectedPattern = body?.selectedPattern as string | undefined;
  const selectedScope = body?.selectedScope as string | undefined;

  if (!requestId || typeof requestId !== "string") {
    throw new BadRequestError("requestId is required");
  }

  const peeked = pendingInteractions.get(requestId);
  if (!peeked) {
    log.warn(
      { requestId, decision },
      "Confirmation POST for unknown requestId (already consumed or never registered)",
    );
    throw new NotFoundError("No pending interaction found for this requestId");
  }

  const effectiveDecision =
    typeof decision === "string"
      ? canonicalizeConfirmDecision({ decision, interaction: peeked })
      : null;

  if (effectiveDecision == null) {
    throw new BadRequestError("decision must resolve to allow or deny");
  }

  // Validation passed. Use get() here — the prompter (or ACP directResolve path)
  // owns deregistration via pendingInteractions.resolve().
  const interaction = peeked;

  log.info(
    {
      requestId,
      decision: effectiveDecision,
      toolName: interaction.confirmationDetails?.toolName,
      conversationId: interaction.conversationId,
    },
    "Confirmation resolved",
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
  // No PermissionPrompter involved, so the route owns deregistration.
  if (interaction.directResolve) {
    pendingInteractions.resolve(requestId);
    interaction.directResolve(effectiveDecision as UserDecision);
    return { accepted: true };
  }

  const conversation = findConversation(interaction.conversationId);
  if (!conversation) {
    throw new NotFoundError(
      "Conversation not found for this pending confirmation",
    );
  }

  conversation.handleConfirmationResponse(
    requestId,
    effectiveDecision as UserDecision,
    selectedPattern,
    selectedScope,
    undefined,
    {
      source: "button",
    },
  );

  return { accepted: true };
}

/**
 * POST /v1/secret — resolve a pending secret request by requestId.
 */
function handleSecret({ body }: RouteHandlerArgs) {
  const requestId = body?.requestId as string | undefined;
  const value = body?.value as string | undefined;
  const delivery = body?.delivery as string | undefined;

  if (!requestId || typeof requestId !== "string") {
    throw new BadRequestError("requestId is required");
  }

  if (
    delivery !== undefined &&
    delivery !== "store" &&
    delivery !== "transient_send"
  ) {
    throw new BadRequestError('delivery must be "store" or "transient_send"');
  }

  // Use get() — SecretPrompter.resolveSecret() owns deregistration.
  const interaction = pendingInteractions.get(requestId);
  if (!interaction) {
    throw new NotFoundError("No pending interaction found for this requestId");
  }

  const conversation = findConversation(interaction.conversationId);
  if (!conversation) {
    throw new NotFoundError(
      "Conversation not found for this pending secret request",
    );
  }

  conversation.handleSecretResponse(
    requestId,
    value,
    delivery as "store" | "transient_send" | undefined,
  );
  return { accepted: true };
}

/**
 * GET /v1/pending-interactions?conversationKey=...&conversationId=...
 *
 * Returns pending interactions. When conversationKey or conversationId is
 * provided, returns the first pending confirmation and secret for that
 * conversation. When neither is provided, returns all pending interactions
 * across all conversations (diagnostic mode).
 */
function handleListPendingInteractions({ queryParams }: RouteHandlerArgs) {
  const conversationKey = queryParams?.conversationKey;
  const conversationId = queryParams?.conversationId;

  // When no filters are provided, return all interactions (diagnostic mode).
  if (!conversationId && !conversationKey) {
    const all = pendingInteractions.getAll();
    return {
      interactions: all.map((i) => ({
        requestId: i.requestId,
        conversationId: i.conversationId,
        kind: i.kind,
        toolName: i.confirmationDetails?.toolName,
        riskLevel: i.confirmationDetails?.riskLevel,
      })),
    };
  }

  let resolvedConversationId: string | undefined;
  if (conversationId) {
    resolvedConversationId = conversationId;
  } else if (conversationKey) {
    const mapping = getConversationByKey(conversationKey);
    resolvedConversationId = mapping?.conversationId;
  }

  if (!resolvedConversationId) {
    return { pendingConfirmation: null, pendingSecret: null };
  }

  const interactions = pendingInteractions.getByConversation(
    resolvedConversationId,
  );

  const confirmation = interactions.find(
    (i) => i.kind === "confirmation" || i.kind === "acp_confirmation",
  );
  const secret = interactions.find((i) => i.kind === "secret");

  return {
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
  };
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "confirm",
    endpoint: "confirm",
    method: "POST",
    handler: handleConfirm,
    requireGuardian: true,
    summary: "Resolve a pending confirmation",
    description: "Approve or deny a pending tool confirmation by requestId.",
    tags: ["approvals"],
    requestBody: z.object({
      requestId: z.string().describe("Pending interaction request ID"),
      decision: z.string().describe("One of: allow, deny"),
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
  },
  {
    operationId: "secret",
    endpoint: "secret",
    method: "POST",
    handler: handleSecret,
    requireGuardian: true,
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
  },
  {
    operationId: "pending_interactions",
    endpoint: "pending-interactions",
    method: "GET",
    handler: handleListPendingInteractions,
    summary: "List pending interactions",
    description:
      "Return pending interactions. When conversationKey or conversationId is provided, returns details for that conversation. When neither is provided, returns all pending interactions.",
    tags: ["approvals"],
    queryParams: [
      {
        name: "conversationKey",
        description: "Conversation key (optional)",
      },
      {
        name: "conversationId",
        description: "Conversation ID (optional)",
      },
    ],
    responseBody: z.object({
      pendingConfirmation: z
        .object({})
        .passthrough()
        .describe("Pending confirmation details or null")
        .optional(),
      pendingSecret: z
        .object({})
        .passthrough()
        .describe("Pending secret request or null")
        .optional(),
      interactions: z
        .array(
          z.object({
            requestId: z.string(),
            conversationId: z.string(),
            kind: z.string(),
            toolName: z.string().optional(),
            riskLevel: z.string().optional(),
          }),
        )
        .describe("All pending interactions (returned when no filters given)")
        .optional(),
    }),
  },
];
