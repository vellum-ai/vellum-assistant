/**
 * IPC route definitions for gateway log reads.
 *
 * Exposes gateway-owned logs to the assistant over the local IPC socket
 * without requiring the assistant to mint gateway-audience bearer tokens.
 */

import { z } from "zod";

import type { GatewayConfig } from "../config.js";
import { LEVEL_NAMES, tailGatewayLogs } from "../http/routes/log-tail.js";
import type { IpcRoute } from "./server.js";

const GatewayLogsTailParamsSchema = z
  .object({
    n: z.number().int().min(1).max(1000).optional(),
    level: z.enum(LEVEL_NAMES).optional(),
    module: z.string().optional(),
  })
  .strict()
  .default({});

export function createLogTailRoutes(config: GatewayConfig): IpcRoute[] {
  return [
    {
      method: "gateway_logs_tail",
      schema: GatewayLogsTailParamsSchema,
      handler: (params?: Record<string, unknown>) =>
        tailGatewayLogs(config, GatewayLogsTailParamsSchema.parse(params)),
    },
  ];
}
