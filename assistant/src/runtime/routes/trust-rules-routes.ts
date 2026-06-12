/**
 * Trust rule listing route — gateway IPC proxy.
 *
 * The handler calls the gateway over the local IPC socket because trust rule
 * storage is gateway-owned in Docker mode.
 */
import {
  TrustRulesListIpcParamsSchema,
  type TrustRulesListIpcResponse,
  TrustRulesListIpcResponseSchema,
} from "@vellumai/gateway-client/gateway-ipc-contracts";

import { ipcCallPersistent } from "../../ipc/gateway-client.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

// ── Handlers ────────────────────────────────────────────────────────────

async function handleList({
  queryParams = {},
  body = {},
}: RouteHandlerArgs): Promise<TrustRulesListIpcResponse> {
  // HTTP GET delivers filters via queryParams; CLI IPC puts them in body.
  const source = Object.keys(queryParams).length > 0 ? queryParams : body;
  const p = TrustRulesListIpcParamsSchema.parse(source);
  const result = await ipcCallPersistent("trust_rules_list", p);
  return TrustRulesListIpcResponseSchema.parse(result);
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
    responseBody: TrustRulesListIpcResponseSchema,
    queryParams: [
      { name: "tool", description: "Filter by tool name" },
      { name: "origin", description: "Filter by origin" },
      { name: "include_all", description: "Include unmodified defaults" },
    ],
  },
];
