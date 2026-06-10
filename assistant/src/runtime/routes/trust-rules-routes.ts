/**
 * Trust rule listing route — gateway IPC proxy.
 *
 * The handler calls the gateway over the local IPC socket because trust rule
 * storage is gateway-owned in Docker mode.
 */
import { z } from "zod";

import { ipcCall } from "../../ipc/gateway-client.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

// ── Schemas ─────────────────────────────────────────────────────────────

const TrustRulesListParams = z
  .object({
    tool: z.string().optional(),
    origin: z.string().optional(),
    include_all: z.boolean().optional(),
  })
  .strict();

const TrustRuleSchema = z.object({
  id: z.string(),
  tool: z.string(),
  pattern: z.string(),
  risk: z.enum(["low", "medium", "high"]),
  description: z.string(),
  origin: z.enum(["default", "user_defined"]),
  userModified: z.boolean(),
  deleted: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const TrustRulesListResponseSchema = z.object({
  rules: z.array(TrustRuleSchema),
});
type TrustRulesListResponse = z.infer<typeof TrustRulesListResponseSchema>;

// ── Handlers ────────────────────────────────────────────────────────────

async function handleList({
  queryParams = {},
  body = {},
}: RouteHandlerArgs): Promise<TrustRulesListResponse> {
  // HTTP GET delivers filters via queryParams; CLI IPC puts them in body.
  const source = Object.keys(queryParams).length > 0 ? queryParams : body;
  const p = TrustRulesListParams.parse(source);
  const result = await ipcCall("trust_rules_list", p);
  if (result === undefined) {
    throw new Error("Gateway IPC request failed");
  }
  return TrustRulesListResponseSchema.parse(result);
}

// ── Route definitions ───────────────────────────────────────────────────

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "trust_rules_list",
    method: "GET",
    policy: {
      requiredScopes: ["approval.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    endpoint: "trust-rules",
    handler: handleList,
    summary: "List trust rules",
    description:
      "List trust rules, optionally filtered by tool, origin, or include_all.",
    tags: ["trust-rules"],
    responseBody: TrustRulesListResponseSchema,
    queryParams: [
      { name: "tool", description: "Filter by tool name" },
      { name: "origin", description: "Filter by origin" },
      { name: "include_all", description: "Include unmodified defaults" },
    ],
  },
];
