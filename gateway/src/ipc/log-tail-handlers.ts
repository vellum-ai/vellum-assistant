/**
 * IPC route definitions for gateway log reads.
 *
 * Exposes gateway-owned logs to the assistant over the local IPC socket
 * without requiring the assistant to mint gateway-audience bearer tokens.
 */

import { GatewayLogsTailIpcParamsSchema } from "@vellumai/gateway-client/gateway-ipc-contracts";

import type { GatewayConfig } from "../config.js";
import { tailGatewayLogs } from "../http/routes/log-tail.js";
import type { IpcRoute } from "./server.js";

export function createLogTailRoutes(config: GatewayConfig): IpcRoute[] {
  return [
    {
      method: "gateway_logs_tail",
      schema: GatewayLogsTailIpcParamsSchema,
      handler: (params?: Record<string, unknown>) =>
        tailGatewayLogs(config, GatewayLogsTailIpcParamsSchema.parse(params)),
    },
  ];
}
