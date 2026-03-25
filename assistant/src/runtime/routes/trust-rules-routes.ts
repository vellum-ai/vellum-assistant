/**
 * Route handlers for trust rule CRUD operations.
 *
 * These endpoints manage persistent trust rules independently of
 * the approval-flow trust-rule endpoint in approval-routes.ts.
 * All endpoints are bearer-token authenticated (standard runtime auth).
 */
import { z } from "zod";

import {
  addRule,
  getAllRules,
  removeRule,
  updateRule,
} from "../../permissions/trust-store.js";
import { getLogger } from "../../util/logger.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";

const log = getLogger("trust-rules-routes");

/**
 * GET /v1/trust-rules/manage — list all trust rules.
 */
function handleListTrustRules(): Response {
  const rules = getAllRules();
  return Response.json({ type: "trust_rules_list_response", rules });
}

/**
 * POST /v1/trust-rules/manage — add a trust rule (standalone, not approval-flow).
 *
 * Body: { toolName, pattern, scope, decision, allowHighRisk?, executionTarget? }
 */
export async function handleAddTrustRuleManage(
  req: Request,
): Promise<Response> {
  const body = (await req.json()) as {
    toolName?: string;
    pattern?: string;
    scope?: string;
    decision?: string;
    allowHighRisk?: boolean;
    executionTarget?: string;
  };

  const { toolName, pattern, scope, decision, allowHighRisk, executionTarget } =
    body;

  if (!toolName || typeof toolName !== "string") {
    return httpError("BAD_REQUEST", "toolName is required", 400);
  }
  if (toolName.startsWith("__internal:")) {
    return httpError(
      "BAD_REQUEST",
      "toolName must not start with __internal:",
      400,
    );
  }
  if (!pattern || typeof pattern !== "string") {
    return httpError("BAD_REQUEST", "pattern is required", 400);
  }
  if (!scope || typeof scope !== "string") {
    return httpError("BAD_REQUEST", "scope is required", 400);
  }
  const validDecisions = ["allow", "deny", "ask"] as const;
  if (
    !decision ||
    !validDecisions.includes(decision as (typeof validDecisions)[number])
  ) {
    return httpError(
      "BAD_REQUEST",
      "decision must be one of: allow, deny, ask",
      400,
    );
  }

  try {
    const hasMetadata = allowHighRisk != null || executionTarget != null;
    addRule(
      toolName,
      pattern,
      scope,
      decision as "allow" | "deny" | "ask",
      undefined,
      hasMetadata ? { allowHighRisk, executionTarget } : undefined,
    );
    log.info(
      { toolName, pattern, scope, decision },
      "Trust rule added via HTTP",
    );
    return Response.json({ ok: true });
  } catch (err) {
    log.error(
      { err, toolName, pattern, scope },
      "Failed to add trust rule via HTTP",
    );
    return httpError("INTERNAL_ERROR", "Failed to add trust rule", 500);
  }
}

/**
 * DELETE /v1/trust-rules/manage/:id — remove a trust rule by ID.
 */
export function handleRemoveTrustRuleManage(id: string): Response {
  try {
    const removed = removeRule(id);
    if (!removed) {
      return httpError("NOT_FOUND", "Trust rule not found", 404);
    }
    log.info({ id }, "Trust rule removed via HTTP");
    return Response.json({ ok: true });
  } catch (err) {
    log.error({ err, id }, "Failed to remove trust rule via HTTP");
    return httpError("INTERNAL_ERROR", "Failed to remove trust rule", 500);
  }
}

/**
 * PATCH /v1/trust-rules/manage/:id — update fields on an existing trust rule.
 *
 * Body: { tool?, pattern?, scope?, decision?, priority? }
 */
export async function handleUpdateTrustRuleManage(
  req: Request,
  id: string,
): Promise<Response> {
  const body = (await req.json()) as {
    tool?: string;
    pattern?: string;
    scope?: string;
    decision?: string;
    priority?: number;
  };

  if (typeof body.tool === "string" && body.tool.startsWith("__internal:")) {
    return httpError(
      "BAD_REQUEST",
      "tool must not start with __internal:",
      400,
    );
  }
  if (body.decision !== undefined) {
    const validDecisions = ["allow", "deny", "ask"] as const;
    if (
      !validDecisions.includes(body.decision as (typeof validDecisions)[number])
    ) {
      return httpError(
        "BAD_REQUEST",
        "decision must be one of: allow, deny, ask",
        400,
      );
    }
  }

  try {
    updateRule(id, {
      tool: body.tool,
      pattern: body.pattern,
      scope: body.scope,
      decision: body.decision as "allow" | "deny" | "ask" | undefined,
      priority: body.priority,
    });
    log.info({ id }, "Trust rule updated via HTTP");
    return Response.json({ ok: true });
  } catch (err) {
    log.error({ err, id }, "Failed to update trust rule via HTTP");
    return httpError("INTERNAL_ERROR", "Failed to update trust rule", 500);
  }
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function trustRulesRouteDefinitions(): RouteDefinition[] {
  return [
    {
      endpoint: "trust-rules/manage",
      method: "GET",
      summary: "List all trust rules",
      description: "Return all persistent trust rules.",
      tags: ["trust-rules"],
      responseBody: z.object({
        type: z.string(),
        rules: z.array(z.unknown()).describe("Trust rule objects"),
      }),
      handler: () => handleListTrustRules(),
    },
    {
      endpoint: "trust-rules/manage",
      method: "POST",
      summary: "Add a trust rule",
      description:
        "Create a new persistent trust rule (standalone, not approval-flow).",
      tags: ["trust-rules"],
      requestBody: z.object({
        toolName: z.string().describe("Tool name"),
        pattern: z.string().describe("Allowlist pattern"),
        scope: z.string().describe("Scope"),
        decision: z.string().describe("allow, deny, or ask"),
        allowHighRisk: z
          .boolean()
          .describe("Allow high-risk invocations")
          .optional(),
        executionTarget: z.string().describe("Execution target").optional(),
      }),
      responseBody: z.object({
        ok: z.boolean(),
      }),
      handler: async ({ req }) => handleAddTrustRuleManage(req),
    },
    {
      endpoint: "trust-rules/manage/:id",
      method: "DELETE",
      summary: "Remove a trust rule",
      description: "Delete a trust rule by ID.",
      tags: ["trust-rules"],
      responseBody: z.object({
        ok: z.boolean(),
      }),
      handler: ({ params }) => handleRemoveTrustRuleManage(params.id),
    },
    {
      endpoint: "trust-rules/manage/:id",
      method: "PATCH",
      summary: "Update a trust rule",
      description: "Partially update fields on an existing trust rule.",
      tags: ["trust-rules"],
      requestBody: z.object({
        tool: z.string().describe("Tool name"),
        pattern: z.string().describe("Allowlist pattern"),
        scope: z.string().describe("Scope"),
        decision: z.string().describe("allow, deny, or ask"),
        priority: z.number().describe("Rule priority"),
      }),
      responseBody: z.object({
        ok: z.boolean(),
      }),
      handler: async ({ req, params }) =>
        handleUpdateTrustRuleManage(req, params.id),
    },
  ];
}
