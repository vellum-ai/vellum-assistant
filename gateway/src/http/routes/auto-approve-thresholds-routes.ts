import { z } from "zod";

import type { GatewayRouteDefinition } from "./types.js";

/**
 * OpenAPI route metadata for the auto-approve threshold API — the global
 * per-execution-mode risk thresholds and per-conversation overrides.
 *
 * These schemas are the codegen source of truth for the generated gateway
 * SDK (see scripts/generate-openapi.ts). Clients consume the operations
 * through the SDK, which targets the assistant-scoped
 * `/v1/assistants/{assistant_id}/permissions/thresholds...` route variants
 * registered in `index.ts` alongside the flat paths documented here.
 *
 * The handlers live in `auto-approve-thresholds.ts`. This module is
 * intentionally schema-only so the codegen script can import it without
 * pulling in DB dependencies.
 */

const ThresholdSchema = z.enum(["none", "low", "medium", "high"]);

const GlobalThresholdsSchema = z.object({
  interactive: ThresholdSchema,
  autonomous: ThresholdSchema,
  headless: ThresholdSchema,
});

export const ROUTES: GatewayRouteDefinition[] = [
  {
    path: "/v1/permissions/thresholds",
    method: "get",
    operationId: "permissionsThresholdsGet",
    summary: "Get global auto-approve thresholds",
    tags: ["permissions"],
    responseBody: GlobalThresholdsSchema,
  },
  {
    path: "/v1/permissions/thresholds",
    method: "put",
    operationId: "permissionsThresholdsPut",
    summary: "Update global auto-approve thresholds",
    description:
      "Partial update — omitted modes keep their current value. Returns the full post-update set.",
    tags: ["permissions"],
    requestBody: z.object({
      interactive: ThresholdSchema.optional(),
      autonomous: ThresholdSchema.optional(),
      headless: ThresholdSchema.optional(),
    }),
    responseBody: GlobalThresholdsSchema,
  },
  {
    path: "/v1/permissions/thresholds/conversations/{conversation_id}",
    method: "get",
    operationId: "conversationThresholdGet",
    summary: "Get a conversation's threshold override",
    description:
      "Returns { threshold: null } when no override exists. (Gateways predating that behavior returned 404 for the same condition; clients tolerate both during rollout.)",
    tags: ["permissions"],
    pathParameters: [
      { name: "conversation_id", description: "The conversation id" },
    ],
    responseBody: z.object({ threshold: z.string().nullable() }),
  },
  {
    path: "/v1/permissions/thresholds/conversations/{conversation_id}",
    method: "put",
    operationId: "conversationThresholdPut",
    summary: "Set a conversation's threshold override",
    tags: ["permissions"],
    pathParameters: [
      { name: "conversation_id", description: "The conversation id" },
    ],
    requestBody: z.object({ threshold: ThresholdSchema }),
    responseBody: z.object({
      conversationId: z.string(),
      threshold: ThresholdSchema,
    }),
  },
  {
    path: "/v1/permissions/thresholds/conversations/{conversation_id}",
    method: "delete",
    operationId: "conversationThresholdDelete",
    summary: "Clear a conversation's threshold override",
    description: "Idempotent — succeeds even when no override exists.",
    tags: ["permissions"],
    pathParameters: [
      { name: "conversation_id", description: "The conversation id" },
    ],
    responseStatus: "204",
  },
];
