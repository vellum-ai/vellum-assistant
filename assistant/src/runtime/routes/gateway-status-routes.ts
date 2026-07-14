/**
 * Gateway status route — Velay tunnel status via the gateway IPC proxy.
 *
 * The Velay tunnel is the gateway's outbound public-ingress transport. It is
 * only used to tunnel inbound Twilio webhooks and live voice/audio WebSockets
 * to this assistant — it plays no part in platform credentials or the managed
 * LLM proxy. The handler reads the live status from the gateway over the local
 * IPC socket, so the assistant does not need gateway signing material.
 */
import { z } from "zod";

import { ipcGetVelayStatus } from "../../ipc/gateway-client.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

// ── Schemas ─────────────────────────────────────────────────────────────

const VelayTunnelStatusSchema = z.object({
  connected: z.boolean(),
  publicUrl: z.string().nullable(),
});

const GatewayStatusResponseSchema = z.object({
  // null when the gateway is unreachable (i.e. not running).
  velayTunnel: VelayTunnelStatusSchema.nullable(),
});
type GatewayStatusResponse = z.infer<typeof GatewayStatusResponseSchema>;

// ── Handlers ────────────────────────────────────────────────────────────

async function handleGatewayStatus(
  _args: RouteHandlerArgs,
): Promise<GatewayStatusResponse> {
  const velayTunnel = await ipcGetVelayStatus().catch(() => null);
  return { velayTunnel };
}

// ── Route definitions ───────────────────────────────────────────────────

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "gateway_status",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    endpoint: "gateway/status",
    handler: handleGatewayStatus,
    summary: "Get gateway status",
    description:
      "Reports the live Velay tunnel status from the gateway. The Velay tunnel only matters for tunnelling inbound Twilio webhooks and live voice/audio WebSockets; velayTunnel is null when the gateway is not running.",
    tags: ["gateway"],
    responseBody: GatewayStatusResponseSchema,
  },
];
