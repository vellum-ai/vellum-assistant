/**
 * Gateway log tail route — gateway IPC proxy.
 *
 * The handler calls the gateway over the local IPC socket so the assistant
 * does not need gateway signing material.
 */
import { z } from "zod";

import { ipcCall } from "../../ipc/gateway-client.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

// ── Schemas ─────────────────────────────────────────────────────────────

const LEVEL_NAMES = [
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
] as const;

const GatewayLogsTailParams = z
  .object({
    n: z.coerce.number().int().min(1).max(1000).optional(),
    level: z.enum(LEVEL_NAMES).optional(),
    module: z.string().optional(),
  })
  .strict();

const GatewayLogsTailResponseSchema = z.object({
  lines: z.array(z.record(z.string(), z.unknown())),
  truncated: z.boolean(),
});
type GatewayLogsTailResponse = z.infer<typeof GatewayLogsTailResponseSchema>;

// ── Handlers ────────────────────────────────────────────────────────────

async function handleGatewayLogsTail({
  queryParams = {},
  body = {},
}: RouteHandlerArgs): Promise<GatewayLogsTailResponse> {
  // HTTP GET delivers filters via queryParams; CLI IPC puts them in body.
  const source = Object.keys(queryParams).length > 0 ? queryParams : body;
  const p = GatewayLogsTailParams.parse(source);
  const result = await ipcCall("gateway_logs_tail", p);
  if (result === undefined) {
    throw new Error("Gateway IPC request failed");
  }
  return GatewayLogsTailResponseSchema.parse(result);
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
    responseBody: GatewayLogsTailResponseSchema,
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
