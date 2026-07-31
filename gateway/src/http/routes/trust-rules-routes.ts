import { z } from "zod";

import type { GatewayRouteDefinition } from "./types.js";

/**
 * OpenAPI route metadata for the trust-rules v3 API.
 *
 * These schemas are the codegen source of truth for the generated gateway
 * SDK (see scripts/generate-openapi.ts). Clients consume the operations
 * through the SDK, which targets the assistant-scoped
 * `/v1/assistants/{assistant_id}/trust-rules/...` route variants registered
 * in `index.ts` alongside the flat paths documented here.
 *
 * The handlers live in `trust-rules.ts`; that module imports the request
 * schemas defined here so wire validation and the published spec cannot
 * drift. This module is intentionally schema-only so the codegen script
 * can import it without pulling in DB or IPC dependencies.
 */

export const TrustRuleRiskSchema = z.enum(["low", "medium", "high"]);

const TrustRuleSchema = z.object({
  id: z.string(),
  tool: z.string(),
  pattern: z.string(),
  risk: TrustRuleRiskSchema,
  description: z.string(),
  origin: z.enum(["default", "user_defined"]),
  userModified: z.boolean(),
  deleted: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const CreateTrustRuleRequestSchema = z.object({
  tool: z.string().min(1),
  pattern: z.string().min(1),
  risk: TrustRuleRiskSchema,
  description: z.string().min(1),
  scope: z
    .string()
    .optional()
    .describe(
      "Directory scope selected in the rule editor. Accepted on the wire but not yet persisted by the gateway.",
    ),
});

const UpdateTrustRuleRequestSchema = z.object({
  risk: TrustRuleRiskSchema.optional(),
  description: z.string().optional(),
});

/**
 * Request body for POST /v1/trust-rules/suggest. `trust-rules.ts` validates
 * inbound bodies with this exact schema.
 */
export const TrustRuleSuggestRequestSchema = z.object({
  tool: z.string().min(1),
  command: z.string().min(1),
  riskAssessment: z.object({
    risk: z.string(),
    reasoning: z.string(),
    reasonDescription: z.string(),
  }),
  scopeOptions: z.array(
    z.object({
      pattern: z.string(),
      label: z.string(),
    }),
  ),
  directoryScopeOptions: z
    .array(
      z.object({
        scope: z.string(),
        label: z.string(),
      }),
    )
    .optional(),
  intent: z.enum(["auto_approve", "escalate"]),
  existingRule: z
    .object({
      id: z.string(),
      pattern: z.string(),
      risk: z.string(),
    })
    .optional(),
});

const TrustRuleSuggestionSchema = z.object({
  pattern: z.string(),
  risk: z.string(),
  scope: z.string().nullable(),
  description: z.string(),
  scopeOptions: z.array(z.object({ pattern: z.string(), label: z.string() })),
  directoryScopeOptions: z
    .array(z.object({ scope: z.string(), label: z.string() }))
    .nullable()
    .optional(),
});

export const ROUTES: GatewayRouteDefinition[] = [
  {
    path: "/v1/trust-rules",
    method: "get",
    operationId: "trustRulesList",
    summary: "List trust rules",
    description:
      "Returns trust rules, filtered to user-relevant rules by default. Pass include_all=true for the full set or origin/tool to filter.",
    tags: ["trust-rules"],
    queryParameters: [
      {
        name: "origin",
        description: "Filter by origin (default | user_defined)",
      },
      { name: "tool", description: "Filter by tool name" },
      {
        name: "include_deleted",
        description: '"true" to include soft-deleted rules',
      },
      {
        name: "include_all",
        description: '"true" to disable the user-relevant filter',
      },
    ],
    responseBody: z.object({ rules: z.array(TrustRuleSchema) }),
  },
  {
    path: "/v1/trust-rules",
    method: "post",
    operationId: "trustRuleCreate",
    summary: "Create a trust rule",
    tags: ["trust-rules"],
    requestBody: CreateTrustRuleRequestSchema,
    responseStatus: "201",
    responseBody: z.object({ rule: TrustRuleSchema }),
  },
  {
    path: "/v1/trust-rules/suggest",
    method: "post",
    operationId: "trustRuleSuggest",
    summary: "Generate a trust-rule suggestion",
    description:
      "LLM-backed suggestion for a rule matching the given tool invocation. Returns 503 when the daemon suggestion relay is unavailable.",
    tags: ["trust-rules"],
    requestBody: TrustRuleSuggestRequestSchema,
    responseBody: z.object({ suggestion: TrustRuleSuggestionSchema }),
  },
  {
    path: "/v1/trust-rules/{rule_id}",
    method: "patch",
    operationId: "trustRuleUpdate",
    summary: "Update a trust rule",
    description:
      "Updates risk and/or description. Updating a default-origin rule marks it userModified.",
    tags: ["trust-rules"],
    pathParameters: [{ name: "rule_id", description: "The trust rule id" }],
    requestBody: UpdateTrustRuleRequestSchema,
    responseBody: z.object({ rule: TrustRuleSchema }),
  },
  {
    path: "/v1/trust-rules/{rule_id}",
    method: "delete",
    operationId: "trustRuleDelete",
    summary: "Delete a trust rule",
    description:
      "Soft-deletes the rule. Default-origin rules can be reset later.",
    tags: ["trust-rules"],
    pathParameters: [{ name: "rule_id", description: "The trust rule id" }],
    responseBody: z.object({ success: z.boolean() }),
  },
  {
    path: "/v1/trust-rules/{rule_id}/reset",
    method: "post",
    operationId: "trustRuleReset",
    summary: "Reset a default trust rule",
    description:
      "Restores a default-origin rule to its registry risk and description, clearing userModified and deleted.",
    tags: ["trust-rules"],
    pathParameters: [{ name: "rule_id", description: "The trust rule id" }],
    responseBody: z.object({ rule: TrustRuleSchema }),
  },
];
