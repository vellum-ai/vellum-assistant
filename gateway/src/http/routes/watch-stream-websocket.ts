/**
 * `/v1/watch/stream`: a watch session's narration, proxied to the runtime.
 *
 * The client half of a watch session is a microphone and this socket
 * (`clients/web/src/domains/chat/watch/watch-controller.ts`); the runtime half
 * turns the narration into a timeline and decides when to read the user's
 * screen (`assistant/src/runtime/routes/watch-routes.ts`). Neither can reach
 * the other directly: the runtime is unreachable from outside the private
 * network, so this is the hop that makes the feature work from a browser at
 * all.
 *
 * The auth gate and the frame pump are `runtime-audio-stream.ts`'s, shared
 * with `/v1/stt/stream`. The two carry different audio to different ends of
 * the runtime and are the same proxy, so they are one implementation with two
 * queries rather than two implementations that agree today.
 */

import {
  authorizeRuntimeAudioStream,
  createRuntimeAudioStreamHandlers,
  type RuntimeAudioStreamState,
} from "./runtime-audio-stream.js";
import type { GatewayConfig } from "../../config.js";
import { getLogger } from "../../logger.js";

const log = getLogger("watch-stream-ws");

export type WatchStreamSocketData = RuntimeAudioStreamState & {
  wsType: "watch-stream";
  /** MIME type of the narration audio (`audio/pcm` from the web capture). */
  mimeType: string;
  /** Sample rate in Hz, when applicable. */
  sampleRate?: number;
  /**
   * Conversation the session's timeline is filed against, when the client
   * names one. Absent lets the runtime mint a conversation for the session,
   * which is what the companion surface's Watch does: it starts a session
   * rather than joining a thread.
   */
  conversationId?: string;
  /**
   * Host client whose screen the session reads, when the client names one.
   * Absent lets the runtime resolve the actor's own host, which is the only
   * choice on a machine with one.
   */
  clientId?: string;
};

/**
 * Create the upgrade handler for `/v1/watch/stream`.
 *
 * Authenticates the downstream actor here and dials upstream with a
 * short-lived service token, which is what lets the runtime resolve the acting
 * principal from its own guardian rather than from anything the client sent.
 */
export function createWatchStreamWebsocketHandler(config: GatewayConfig) {
  return function handleUpgrade(
    req: Request,
    server: import("bun").Server<unknown>,
  ): Response | undefined {
    const denied = authorizeRuntimeAudioStream(req, config, log);
    if (denied) {
      return denied;
    }

    const url = new URL(req.url);
    const mimeType = url.searchParams.get("mimeType");
    if (!mimeType) {
      return new Response("Missing required query parameter: mimeType", {
        status: 400,
      });
    }

    const sampleRateRaw = url.searchParams.get("sampleRate");
    const sampleRate = sampleRateRaw ? parseInt(sampleRateRaw, 10) : undefined;
    const conversationId =
      url.searchParams.get("conversationId")?.trim() || undefined;
    const clientId = url.searchParams.get("clientId")?.trim() || undefined;

    const upgraded = server.upgrade(req, {
      data: {
        wsType: "watch-stream",
        config,
        mimeType,
        sampleRate,
        conversationId,
        clientId,
      } satisfies WatchStreamSocketData,
    });

    if (!upgraded) {
      return new Response("WebSocket upgrade failed", { status: 500 });
    }

    return undefined;
  };
}

/**
 * WebSocket handlers for Bun.serve() that pump narration audio to the
 * runtime's `/v1/watch/stream` and its lifecycle frames back.
 */
export function getWatchStreamWebsocketHandlers() {
  return createRuntimeAudioStreamHandlers<WatchStreamSocketData>({
    upstreamPath: "/v1/watch/stream",
    log,
    label: "watch stream",
    upstreamParams: ({ mimeType, sampleRate, conversationId, clientId }) => {
      const params: Record<string, string> = { mimeType };
      if (sampleRate !== undefined) {
        params.sampleRate = String(sampleRate);
      }
      if (conversationId) {
        params.conversationId = conversationId;
      }
      if (clientId) {
        params.clientId = clientId;
      }
      return params;
    },
    logContext: ({ mimeType, sampleRate, conversationId }) => ({
      mimeType,
      sampleRate,
      conversationId,
    }),
  });
}
