/**
 * IPC route definitions for Velay tunnel status.
 *
 * Exports a factory that takes the optional VelayTunnelClient and returns
 * a single `get_velay_status` IPC route. Returns disconnected/null when no
 * client is configured (e.g. VELAY_BASE_URL not set).
 */

import type { VelayStatusIpcResponse } from "@vellumai/gateway-client/gateway-ipc-contracts";

import type { VelayTunnelClient } from "../velay/client.js";
import type { IpcRoute } from "./server.js";

export function createVelayRoutes(
  velayTunnelClient: VelayTunnelClient | undefined,
): IpcRoute[] {
  return [
    {
      method: "get_velay_status",
      handler: (): VelayStatusIpcResponse => {
        if (!velayTunnelClient) {
          return { connected: false, publicUrl: null };
        }
        return velayTunnelClient.getStatus();
      },
    },
  ];
}
