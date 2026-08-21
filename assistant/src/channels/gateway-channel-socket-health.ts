/**
 * Daemon-side reader for whether a socket-backed channel is receiving.
 *
 * The gateway holds the inbound sockets; the readiness surface that reports
 * channel health to the user lives here. This is the relay between them.
 */

import {
  type ChannelSocketHealthIpcParams,
  type ChannelSocketHealthIpcResponse,
  ChannelSocketHealthIpcResponseSchema,
} from "@vellumai/gateway-client/gateway-ipc-contracts";

import { ipcCallPersistentValidated } from "../ipc/gateway-validated-call.js";

/**
 * Ask the gateway whether `channel`'s inbound socket is live.
 *
 * Throws on transport failure rather than reporting a channel as down: an
 * unreachable gateway is a fact about the gateway, and a caller that renders
 * it as "Slack is disconnected" would be inventing an outage. Callers are
 * expected to treat a throw as indeterminate.
 */
export async function readChannelSocketHealth(
  channel: ChannelSocketHealthIpcParams["channel"],
): Promise<ChannelSocketHealthIpcResponse> {
  return ipcCallPersistentValidated(
    "channel_socket_health",
    { channel },
    ChannelSocketHealthIpcResponseSchema,
  );
}
