/**
 * Gateway status route — public tunnel status via the gateway IPC proxy.
 *
 * The tunnel is the gateway's outbound public-ingress transport. It is only
 * used to tunnel inbound Twilio webhooks and live voice/audio WebSockets to
 * this assistant — it plays no part in platform credentials or the managed
 * LLM proxy. The handler reads the live status from the gateway over the local
 * IPC socket, so the assistant does not need gateway signing material.
 *
 * The response is deliberately tunnel-agnostic: a single `tunnel` field holding
 * the active public URL, omitted entirely when no tunnel is connected. This
 * keeps the contract stable if the underlying transport (currently Velay) is
 * ever swapped for another tunnel.
 */
import { z } from "zod";

import { ipcGetVelayStatus } from "../../ipc/gateway-client.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

// ── Schemas ─────────────────────────────────────────────────────────────

const GatewayStatusResponseSchema = z.object({
  // Present with the public tunnel URL when a tunnel is connected; omitted
  // (so the object is `{}`) when no tunnel is up or the gateway is not running.
  tunnel: z.string().optional(),
});
type GatewayStatusResponse = z.infer<typeof GatewayStatusResponseSchema>;

// ── Handlers ────────────────────────────────────────────────────────────

async function handleGatewayStatus(
  _args: RouteHandlerArgs,
): Promise<GatewayStatusResponse> {
  const status = await ipcGetVelayStatus().catch(() => null);
  return status?.connected && status.publicUrl
    ? { tunnel: status.publicUrl }
    : {};
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
      "Reports the gateway's public tunnel status. `tunnel` holds the active public URL when a tunnel is connected and is omitted otherwise. The tunnel only matters for routing inbound Twilio webhooks and live voice/audio WebSockets.",
    tags: ["gateway"],
    responseBody: GatewayStatusResponseSchema,
  },
];
