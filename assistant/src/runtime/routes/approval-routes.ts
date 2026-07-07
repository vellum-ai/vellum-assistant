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

import { findConversation } from "../../daemon/conversation-registry.js";
import type {
  SecretDelivery,
  SecretPromptResult,
} from "../../permissions/secret-prompter.js";
import type { UserDecision } from "../../permissions/types.js";
import { getConversationByKey } from "../../persistence/conversation-key-store.js";
import {
  hasInteriorWhitespace,
  normalizeSecretValue,
} from "../../security/secret-normalize.js";
import { getLogger } from "../../util/logger.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
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

  // ACP permissions: resolve directly without a Conversation object.
  // No PermissionPrompter involved, so the route owns deregistration.
  if (interaction.directResolve) {
    pendingInteractions.resolve(
      requestId,
      effectiveDecision === "allow" ? "approved" : "rejected",
    );
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
    {
      selectedPattern,
      selectedScope,
      emissionContext: { source: "button" },
    },
  );

  return { accepted: true };
}

/**
 * POST /v1/secret — resolve a pending secret request by requestId.
 */
function handleSecret({ body }: RouteHandlerArgs) {
  const requestId = body?.requestId as string | undefined;
  const delivery = body?.delivery as string | undefined;

  if (!requestId || typeof requestId !== "string") {
    throw new BadRequestError("requestId is required");
  }

  // Legacy compat shim: already-shipped web clients send `delivery: "none"` to
  // cancel a secret prompt. Normalize it to the cancellation path (value
  // undefined) so the request settles cleanly rather than 400-ing and stranding
  // the pending interaction.
  const isCancel = delivery === "none";
  const rawValue = isCancel ? undefined : (body?.value as string | undefined);

  const value =
    rawValue === undefined ? undefined : normalizeSecretValue(rawValue);
  if (value !== undefined && value !== rawValue) {
    log.info(
      { hadEdgeWhitespace: true },
      "Trimmed edge whitespace from submitted secret value",
    );
  }
  if (value !== undefined && hasInteriorWhitespace(value)) {
    log.warn(
      { interiorWhitespace: true },
      "Submitted secret contains interior whitespace — expected for multi-line secrets (e.g. PEM keys), unexpected for API tokens",
    );
  }

  if (
    delivery !== undefined &&
    delivery !== "store" &&
    delivery !== "transient_send" &&
    delivery !== "none"
  ) {
    throw new BadRequestError('delivery must be "store" or "transient_send"');
  }

  const effectiveDelivery =
    isCancel || delivery === undefined
      ? undefined
      : (delivery as "store" | "transient_send");

  const interaction = pendingInteractions.get(requestId);
  if (!interaction) {
    throw new NotFoundError("No pending interaction found for this requestId");
  }

  // /v1/secret only settles secret prompts. A requestId belonging to another
  // interaction kind (a confirmation or host-proxy request posted here from
  // stale or mismatched client state) must not be consumed or resolved with a
  // SecretPromptResult, which would strand its real approval/result endpoint.
  if (interaction.kind !== "secret") {
    throw new NotFoundError(
      "No pending secret request found for this requestId",
    );
  }

  // When a live conversation owns the request, route through it so the
  // SecretPrompter's ownership tracking and dispose path stay consistent (this
  // also drives the voice auto-resolve path). The prompter owns deregistration.
  const conversation = interaction.conversationId
    ? findConversation(interaction.conversationId)
    : undefined;
  if (conversation?.hasPendingSecret(requestId)) {
    conversation.handleSecretResponse(requestId, value, effectiveDelivery);
    return { accepted: true };
  }

  // Conversation-less requests (e.g. the CLI `credentials prompt` command) and
  // any request no live conversation owns resolve generically via the resolver
  // stored on the interaction, with no Conversation in the loop.
  const resolved = pendingInteractions.resolve(
    requestId,
    value === undefined ? "cancelled" : "answered",
  );
  (resolved?.rpcResolve as ((r: SecretPromptResult) => void) | undefined)?.({
    value: value ?? null,
    delivery: (effectiveDelivery as SecretDelivery) ?? "store",
    // A missing value here is a deliberate user cancel (the client dismissed
    // the prompt), distinct from the timeout path. Tag it so downstream callers
    // can treat it as a valid outcome rather than a failure.
    ...(value === undefined ? { reason: "cancelled" as const } : {}),
  });
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
          service: secret.secretDetails?.service,
          field: secret.secretDetails?.field,
          label: secret.secretDetails?.label,
          description: secret.secretDetails?.description,
          placeholder: secret.secretDetails?.placeholder,
          purpose: secret.secretDetails?.purpose,
          allowedTools: secret.secretDetails?.allowedTools,
          allowedDomains: secret.secretDetails?.allowedDomains,
          allowOneTimeSend: secret.secretDetails?.allowOneTimeSend,
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
    policy: {
      requiredScopes: ["approval.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
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
    policy: {
      requiredScopes: ["approval.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
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
    policy: {
      requiredScopes: ["approval.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
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
        .object({
          requestId: z.string(),
          service: z.string().optional(),
          field: z.string().optional(),
          label: z.string().optional(),
          description: z.string().optional(),
          placeholder: z.string().optional(),
          purpose: z.string().optional(),
          allowedTools: z.array(z.string()).optional(),
          allowedDomains: z.array(z.string()).optional(),
          allowOneTimeSend: z.boolean().optional(),
        })
        .passthrough()
        .nullable()
        .describe("Pending secret request or null")
        .optional(),
      interactions: z
        .array(
          z.object({
            requestId: z.string(),
            conversationId: z.string().optional(),
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
