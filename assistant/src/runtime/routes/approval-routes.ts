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
import { parseTrustRule } from "@vellumai/ces-contracts";
import { z } from "zod";

import { getConversationByKey } from "../../memory/conversation-key-store.js";
import { addRule } from "../../permissions/trust-store.js";
import type { UserDecision } from "../../permissions/types.js";
import {
  isConversationHostAccessDecision,
  isConversationHostAccessEnablePrompt,
  isPermissionControlsV2Enabled,
} from "../../permissions/v2-consent-policy.js";
import { getTool } from "../../tools/registry.js";
import { getLogger } from "../../util/logger.js";
import { requireBoundGuardian } from "../auth/require-bound-guardian.js";
import type { AuthContext } from "../auth/types.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";
import * as pendingInteractions from "../pending-interactions.js";

const log = getLogger("approval-routes");

function canonicalizeV2ConfirmDecision(params: {
  decision: string;
  interaction: NonNullable<ReturnType<typeof pendingInteractions.get>>;
}): UserDecision | null {
  const { decision, interaction } = params;
  if (decision === "allow" || decision === "deny") {
    return decision;
  }

  const details = interaction.confirmationDetails;
  if (!details || isConversationHostAccessEnablePrompt(details)) {
    return null;
  }

  if (
    (decision === "allow_10m" || decision === "allow_conversation") &&
    details.temporaryOptionsAvailable?.includes(decision)
  ) {
    return "allow";
  }

  if (
    (decision === "always_allow" ||
      decision === "always_allow_high_risk" ||
      decision === "always_deny") &&
    details.persistentDecisionsAllowed
  ) {
    return decision === "always_deny" ? "deny" : "allow";
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

  const { requestId, decision, selectedPattern, selectedScope } = body;

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

  const v2Enabled = isPermissionControlsV2Enabled();
  const effectiveDecision = v2Enabled
    ? typeof decision === "string"
      ? canonicalizeV2ConfirmDecision({ decision, interaction: peeked })
      : null
    : decision;
  const validConfirmDecisions = [
    "allow",
    "allow_10m",
    "allow_conversation",
    "deny",
    "always_allow",
    "always_deny",
    "always_allow_high_risk",
  ];
  if (
    (v2Enabled && effectiveDecision == null) ||
    (!v2Enabled &&
      (typeof decision !== "string" ||
        !validConfirmDecisions.includes(decision)))
  ) {
    return httpError(
      "BAD_REQUEST",
      v2Enabled
        ? "decision must resolve to allow or deny under permission-controls-v2"
        : `decision must be one of: ${validConfirmDecisions.join(", ")}`,
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

  if (v2Enabled && (selectedPattern || selectedScope)) {
    return httpError(
      "FORBIDDEN",
      "Scoped or persistent approval selections are not supported under permission-controls-v2",
      403,
    );
  }

  // For decisions that persist trust rules, validate that selectedPattern
  // and selectedScope are among the options the server actually offered.
  // This prevents a crafted request from injecting overly-broad rules.
  const persistsRule =
    decision === "always_allow" ||
    decision === "always_deny" ||
    decision === "always_allow_high_risk";
  if (persistsRule && (selectedPattern || selectedScope)) {
    const confirmation = peeked.confirmationDetails;
    if (!confirmation) {
      return httpError(
        "CONFLICT",
        "No confirmation details available for this request",
        409,
      );
    }

    if (selectedPattern) {
      const validPatterns = (confirmation.allowlistOptions ?? []).map(
        (o) => o.pattern,
      );
      if (!validPatterns.includes(selectedPattern)) {
        return httpError(
          "FORBIDDEN",
          "selectedPattern does not match any server-provided allowlist option",
          403,
        );
      }
    }

    if (selectedScope) {
      const validScopes = (confirmation.scopeOptions ?? []).map((o) => o.scope);
      if (validScopes.length === 0) {
        if (selectedScope !== "everywhere") {
          return httpError(
            "FORBIDDEN",
            'non-scoped tools only accept scope "everywhere"',
            403,
          );
        }
      } else if (!validScopes.includes(selectedScope)) {
        return httpError(
          "FORBIDDEN",
          "selectedScope does not match any server-provided scope option",
          403,
        );
      }
    }
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
 * POST /v1/trust-rules — add a trust rule for a pending confirmation.
 * Requires AuthContext with guardian-bound actor.
 *
 * Does NOT resolve the confirmation itself (the client still needs to
 * POST /v1/confirm to approve/deny). Validates the pattern and scope
 * against the server-provided allowlist options from the original
 * confirmation_request.
 */
export async function handleTrustRule(
  req: Request,
  authContext: AuthContext,
): Promise<Response> {
  const authError = requireBoundGuardian(authContext);
  if (authError) return authError;

  if (isPermissionControlsV2Enabled()) {
    return httpError(
      "FORBIDDEN",
      "Persistent trust rules are not supported under permission-controls-v2",
      403,
    );
  }

  const body = (await req.json()) as {
    requestId?: string;
    pattern?: string;
    scope?: string;
    decision?: string;
    allowHighRisk?: boolean;
  };

  const { requestId, pattern, scope, decision, allowHighRisk } = body;

  if (!requestId || typeof requestId !== "string") {
    return httpError("BAD_REQUEST", "requestId is required", 400);
  }

  if (!pattern || typeof pattern !== "string") {
    return httpError("BAD_REQUEST", "pattern is required", 400);
  }

  if (!scope || typeof scope !== "string") {
    return httpError("BAD_REQUEST", "scope is required", 400);
  }

  if (decision !== "allow" && decision !== "deny") {
    return httpError("BAD_REQUEST", 'decision must be "allow" or "deny"', 400);
  }

  // Look up without removing — trust rule doesn't resolve the confirmation
  const interaction = pendingInteractions.get(requestId);
  if (!interaction) {
    return httpError(
      "NOT_FOUND",
      "No pending interaction found for this requestId",
      404,
    );
  }

  if (!interaction.confirmationDetails) {
    return httpError(
      "CONFLICT",
      "No confirmation details available for this request",
      409,
    );
  }

  const confirmation = interaction.confirmationDetails;

  if (confirmation.persistentDecisionsAllowed === false) {
    return httpError(
      "FORBIDDEN",
      "Persistent trust rules are not allowed for this tool invocation",
      403,
    );
  }

  // Validate pattern against server-provided allowlist options
  const validPatterns = (confirmation.allowlistOptions ?? []).map(
    (o) => o.pattern,
  );
  if (!validPatterns.includes(pattern)) {
    return httpError(
      "FORBIDDEN",
      "pattern does not match any server-provided allowlist option",
      403,
    );
  }

  // Validate scope against server-provided scope options.
  // Non-scoped tools have empty scopeOptions — only "everywhere" is valid for them.
  const validScopes = (confirmation.scopeOptions ?? []).map((o) => o.scope);
  if (validScopes.length === 0) {
    if (scope !== "everywhere") {
      return httpError(
        "FORBIDDEN",
        'non-scoped tools only accept scope "everywhere"',
        403,
      );
    }
  } else if (!validScopes.includes(scope)) {
    return httpError(
      "FORBIDDEN",
      "scope does not match any server-provided scope option",
      403,
    );
  }

  try {
    const tool = getTool(confirmation.toolName);
    const executionTarget =
      tool?.origin === "skill" ? confirmation.executionTarget : undefined;

    // Canonicalize through the shared parser so fields invalid for the tool's
    // family are stripped before persistence. The `always_allow_high_risk`
    // decision maps to `allowHighRisk: true` on the persisted rule for scoped
    // and generic tool families; the parser strips it for families that don't
    // support it (URL, managed-skill, skill-load).
    const { rule: canonical } = parseTrustRule({
      id: "",
      tool: confirmation.toolName,
      pattern,
      scope,
      decision,
      priority: 100,
      createdAt: 0,
      ...(allowHighRisk ? { allowHighRisk: true } : {}),
      ...(executionTarget != null ? { executionTarget } : {}),
    });
    const canonicalOpts =
      "allowHighRisk" in canonical || "executionTarget" in canonical
        ? {
            allowHighRisk: (canonical as { allowHighRisk?: boolean })
              .allowHighRisk,
            executionTarget: (canonical as { executionTarget?: string })
              .executionTarget,
          }
        : undefined;
    addRule(
      canonical.tool,
      canonical.pattern,
      canonical.scope,
      canonical.decision,
      undefined,
      canonicalOpts,
    );
    log.info(
      { tool: confirmation.toolName, pattern, scope, decision, requestId },
      "Trust rule added via HTTP (bound to pending confirmation)",
    );
    return Response.json({ accepted: true });
  } catch (err) {
    log.error({ err }, "Failed to add trust rule");
    return httpError("INTERNAL_ERROR", "Failed to add trust rule", 500);
  }
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
          temporaryOptionsAvailable:
            confirmation.confirmationDetails?.temporaryOptionsAvailable,
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
          .describe(
            "One of: allow, allow_10m, allow_conversation, deny, always_allow, always_deny, always_allow_high_risk",
          ),
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
      endpoint: "trust-rules",
      method: "POST",
      summary: "Add a trust rule for a pending confirmation",
      description:
        "Add a trust rule bound to a pending confirmation without resolving it.",
      tags: ["approvals"],
      requestBody: z.object({
        requestId: z.string().describe("Pending confirmation request ID"),
        pattern: z.string().describe("Allowlist pattern"),
        scope: z.string().describe("Scope for the rule"),
        decision: z.string().describe("allow or deny"),
        allowHighRisk: z
          .boolean()
          .describe("Allow high-risk invocations")
          .optional(),
      }),
      responseBody: z.object({
        accepted: z.boolean(),
      }),
      handler: async ({ req, authContext }) =>
        handleTrustRule(req, authContext),
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
