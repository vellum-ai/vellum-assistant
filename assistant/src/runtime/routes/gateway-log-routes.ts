/**
 * Gateway log tail route — gateway IPC proxy.
 *
 * The handler calls the gateway over the local IPC socket so the assistant
 * does not need gateway signing material.
 */
import {
  type GatewayLogsTailIpcResponse,
  GatewayLogsTailIpcResponseSchema,
  GatewayLogsTailRouteParamsSchema,
} from "@vellumai/gateway-client/gateway-ipc-contracts";

import { ipcCallPersistent } from "../../ipc/gateway-client.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

// ── Handlers ────────────────────────────────────────────────────────────

async function handleGatewayLogsTail({
  queryParams = {},
  body = {},
}: RouteHandlerArgs): Promise<GatewayLogsTailIpcResponse> {
  // HTTP GET delivers filters via queryParams; CLI IPC puts them in body.
  const source = Object.keys(queryParams).length > 0 ? queryParams : body;
  const p = GatewayLogsTailRouteParamsSchema.parse(source);
  const result = await ipcCallPersistent("gateway_logs_tail", p);
  return GatewayLogsTailIpcResponseSchema.parse(result);
}

// ── Route definitions ───────────────────────────────────────────────────

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "gateway_logs_tail",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    endpoint: "gateway/logs/tail",
    handler: handleGatewayLogsTail,
    summary: "Tail gateway log entries",
    description:
      "Return the last N structured log entries from the gateway log files.",
    tags: ["gateway-logs"],
    responseBody: GatewayLogsTailIpcResponseSchema,
    queryParams: [
      {
        name: "n",
        description: "Number of lines to return (1–1000, default: 10)",
      },
      { name: "level", description: "Minimum pino level name (default: info)" },
      { name: "module", description: "Filter to exact pino module name" },
    ],
  },
];
