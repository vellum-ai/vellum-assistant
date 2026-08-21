/**
 * Velay tunnel status endpoint (GET /v1/velay/status).
 *
 * Exposes the in-process VelayTunnelClient state over HTTP so web clients
 * and the CLI can query tunnel connectivity without a custom IPC call.
 * Returns { connected: false, publicUrl: null } when Velay is not configured
 * (VELAY_BASE_URL not set).
 */

import type { VelayTunnelClient } from "../../velay/client.js";

export interface VelayStatusResponse {
  connected: boolean;
  publicUrl: string | null;
}

export function createVelayStatusHandler(
  velayTunnelClient: VelayTunnelClient | undefined,
) {
  function handleVelayStatus(): Response {
    const status: VelayStatusResponse = velayTunnelClient?.getStatus() ?? {
      connected: false,
      publicUrl: null,
    };
    return Response.json(status);
  }

  return { handleVelayStatus };
}
