/**
 * `/v1/desktop/stream`: a containerized assistant's on-demand desktop, proxied
 * to the runtime as a raw RFB (VNC) byte pipe with close codes relayed
 * verbatim. Guardian-only: the proxy replaces the caller's identity upstream,
 * so this upgrade is the only place a non-guardian actor can be refused.
 */

import {
  createRuntimeAudioStreamHandlers,
  type RuntimeAudioStreamState,
} from "./runtime-audio-stream.js";
import { authorizeGuardianStream } from "./guardian-pin.js";
import type { GatewayConfig } from "../../config.js";
import { getLogger } from "../../logger.js";

const log = getLogger("desktop-stream-ws");

export type DesktopStreamSocketData = RuntimeAudioStreamState & {
  wsType: "desktop-stream";
};

/** Upgrade handler for `/v1/desktop/stream`; the route takes no parameters. */
export function createDesktopStreamWebsocketHandler(config: GatewayConfig) {
  return async function handleUpgrade(
    req: Request,
    server: import("bun").Server<unknown>,
  ): Promise<Response | undefined> {
    const denied = await authorizeGuardianStream(req, config, log);
    if (denied) {
      return denied;
    }

    const upgraded = server.upgrade(req, {
      data: {
        wsType: "desktop-stream",
        config,
      } satisfies DesktopStreamSocketData,
    });

    if (!upgraded) {
      return new Response("WebSocket upgrade failed", { status: 500 });
    }

    return undefined;
  };
}

/** `Bun.serve` handlers pumping RFB bytes to the runtime's `/v1/desktop/stream`. */
export function getDesktopStreamWebsocketHandlers() {
  return createRuntimeAudioStreamHandlers<DesktopStreamSocketData>({
    upstreamPath: "/v1/desktop/stream",
    log,
    label: "desktop stream",
    // RFB has no resync: one dropped frame corrupts the framebuffer for the
    // rest of the session, so a drop ends it. The JSON streams next door do
    // not opt in.
    closeOnDroppedFrame: true,
  });
}
