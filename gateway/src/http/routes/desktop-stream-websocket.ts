/**
 * `/v1/desktop/stream`: a containerized assistant's on-demand desktop, proxied
 * to the runtime as a raw RFB (VNC) byte pipe.
 *
 * The client half is a noVNC viewer in the web client; the runtime half
 * bridges the socket to the pod's loopback VNC server. Neither can reach the
 * other directly, since the runtime is unreachable from outside the private
 * network, so this is the hop that makes the feature work from a browser.
 *
 * The socket is RFB and nothing else: every frame in both directions is a
 * binary frame of RFB bytes, passed through verbatim, and there are no control
 * frames for this proxy to inspect. Errors travel as close codes, which the
 * shared pump carries from either side to the other unchanged, so the
 * runtime's `1013` (desktop busy), `1011` (desktop failed to start) and
 * `1008` (feature disabled or unsupported) reach the browser as themselves.
 *
 * Guardian-only, the way the watch stream is and for the same reason: the
 * proxy replaces the caller's identity with a service token upstream, so
 * whoever the gateway admits is who gets the pod's desktop, and this upgrade
 * is the only place a non-guardian actor can be refused.
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

/**
 * Create the upgrade handler for `/v1/desktop/stream`.
 *
 * Authenticates the downstream caller as the bound guardian, on either the
 * managed velay-attested path or the actor edge JWT path, and dials upstream
 * with a short-lived service token. The route takes no query parameters: a
 * session starts with the upgrade and ends with the close.
 */
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

/**
 * WebSocket handlers for Bun.serve() that pump RFB bytes between the viewer
 * and the runtime's `/v1/desktop/stream`.
 */
export function getDesktopStreamWebsocketHandlers() {
  return createRuntimeAudioStreamHandlers<DesktopStreamSocketData>({
    upstreamPath: "/v1/desktop/stream",
    log,
    label: "desktop stream",
  });
}
