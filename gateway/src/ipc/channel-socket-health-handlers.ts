/**
 * IPC route exposing whether a socket-backed channel is currently receiving.
 *
 * The gateway owns the inbound sockets, and the daemon owns the readiness
 * surface that reports channel health to the user, so the answer has to cross
 * the boundary. Webhook channels need no equivalent: their delivery health is
 * a property of a registration, which the daemon can read from the provider
 * directly.
 *
 * Keyed by channel rather than split per channel, because the question and the
 * answer are the same for every socket transport; only the proof of liveness
 * differs, and each client reports that in its own terms.
 */

import {
  ChannelSocketHealthIpcParamsSchema,
  type ChannelSocketHealthIpcParams,
  type ChannelSocketHealthIpcResponse,
} from "@vellumai/gateway-client/gateway-ipc-contracts";

import type { ChannelConnectionHealth } from "../channels/types.js";
import type { IpcRoute } from "./server.js";

/** The slice of a socket-backed channel client this route reads. */
export type SocketHealthSource = {
  getConnectionHealth(): ChannelConnectionHealth;
};

/**
 * Clients are supplied as getters, not values: each is torn down and rebuilt
 * on a credential change, so a captured reference would answer for a client
 * that is no longer the live one.
 */
export type SocketHealthSources = Partial<
  Record<
    ChannelSocketHealthIpcParams["channel"],
    () => SocketHealthSource | null
  >
>;

export function createChannelSocketHealthRoutes(
  sources: SocketHealthSources,
): IpcRoute[] {
  return [
    {
      method: "channel_socket_health",
      schema: ChannelSocketHealthIpcParamsSchema,
      handler: (params?: Record<string, unknown>) => {
        const { channel } = ChannelSocketHealthIpcParamsSchema.parse(params);
        const source = sources[channel];
        if (!source) {
          const response: ChannelSocketHealthIpcResponse = {
            channel,
            status: "unsupported",
          };
          return response;
        }
        const client = source();
        if (!client) {
          const response: ChannelSocketHealthIpcResponse = {
            channel,
            status: "not_configured",
          };
          return response;
        }
        const health = client.getConnectionHealth();
        const response: ChannelSocketHealthIpcResponse = {
          channel,
          status: health.connected ? "connected" : "disconnected",
          ...(health.lastLivenessAt === undefined
            ? {}
            : { lastLivenessAt: health.lastLivenessAt }),
        };
        return response;
      },
    },
  ];
}
