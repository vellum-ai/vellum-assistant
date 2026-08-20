/**
 * `/v1/stt/stream`: the client's dictation audio, proxied to the runtime's
 * streaming transcriber.
 *
 * The token gate and the frame pump are `runtime-audio-stream.ts`'s, shared
 * with the watch stream next door, so the two client-facing audio proxies
 * cannot drift on what a valid caller looks like. Where they deliberately do
 * differ is who may open one: watch is guardian-only and pins the upgrade to
 * the binding, and dictation takes any valid actor, which is why that pin is a
 * route opt-in rather than part of the shared gate.
 *
 * The rest of what is this route's own is the query it accepts and carries
 * upstream.
 */

import {
  authorizeRuntimeAudioStream,
  createRuntimeAudioStreamHandlers,
  type RuntimeAudioStreamState,
} from "./runtime-audio-stream.js";
import type { GatewayConfig } from "../../config.js";
import { getLogger } from "../../logger.js";

const log = getLogger("stt-stream-ws");

export type SttStreamSocketData = RuntimeAudioStreamState & {
  wsType: "stt-stream";
  /**
   * Optional provider identifier for the STT streaming session (e.g.
   * "deepgram", "google-gemini"). The runtime is config-authoritative —
   * it always resolves the streaming transcriber from `services.stt.provider`
   * regardless of this value. When supplied, it is forwarded as compatibility
   * metadata and the runtime logs a mismatch warning if it disagrees with
   * the configured provider.
   */
  provider?: string;
  /** MIME type of the audio being streamed (e.g. "audio/webm;codecs=opus"). */
  mimeType: string;
  /** Sample rate in Hz, when applicable. */
  sampleRate?: number;
};

/**
 * Create a WebSocket upgrade handler that proxies client STT audio frames
 * to the runtime's /v1/stt/stream endpoint.
 *
 * The gateway authenticates the downstream client using an edge JWT and
 * then opens an upstream connection to the runtime with a short-lived
 * gateway service token. This keeps the runtime unreachable from the
 * public internet while allowing authenticated clients to stream audio
 * for real-time transcription.
 */
export function createSttStreamWebsocketHandler(config: GatewayConfig) {
  return function handleUpgrade(
    req: Request,
    server: import("bun").Server<unknown>,
  ): Response | undefined {
    // Any valid actor, deliberately. Dictation is the user's own words going
    // to a transcriber and back; it is not a guardian-only surface, and the
    // watch stream's `guardian-pin` check is exactly what this route does not
    // want.
    const auth = authorizeRuntimeAudioStream(req, config, log);
    if (!auth.ok) {
      return auth.response;
    }

    // ── Query parameters ──
    // mimeType is required; provider is optional compatibility metadata
    // (the runtime resolves the transcriber from config, not from the query).
    const url = new URL(req.url);
    const provider = url.searchParams.get("provider") ?? undefined;
    const mimeType = url.searchParams.get("mimeType");

    if (!mimeType) {
      return new Response("Missing required query parameter: mimeType", {
        status: 400,
      });
    }

    const sampleRateRaw = url.searchParams.get("sampleRate");
    const sampleRate = sampleRateRaw ? parseInt(sampleRateRaw, 10) : undefined;

    const upgraded = server.upgrade(req, {
      data: {
        wsType: "stt-stream",
        config,
        provider,
        mimeType,
        sampleRate,
      } satisfies SttStreamSocketData,
    });

    if (!upgraded) {
      return new Response("WebSocket upgrade failed", { status: 500 });
    }

    // Return undefined to indicate upgrade was handled
    return undefined;
  };
}

/**
 * WebSocket handler config for Bun.serve() that proxies STT audio
 * frames to the runtime's /v1/stt/stream endpoint.
 */
export function getSttStreamWebsocketHandlers() {
  return createRuntimeAudioStreamHandlers<SttStreamSocketData>({
    upstreamPath: "/v1/stt/stream",
    log,
    label: "STT stream",
    upstreamParams: ({ provider, mimeType, sampleRate }) => {
      const params: Record<string, string> = { mimeType };
      if (provider) {
        params.provider = provider;
      }
      if (sampleRate !== undefined) {
        params.sampleRate = String(sampleRate);
      }
      return params;
    },
    logContext: ({ provider, mimeType, sampleRate }) => ({
      provider,
      mimeType,
      sampleRate,
    }),
  });
}
