/**
 * Gateway proxy for the daemon's audio serving endpoint.
 *
 * GET /v1/audio/:audioId — unauthenticated, proxied directly to the daemon.
 *
 * Twilio fetches synthesized TTS audio at these URLs. The audioId is an
 * unguessable UUID that acts as a capability token, so no additional auth
 * is required. This mirrors the daemon's own handling where the audio
 * endpoint is served before the auth middleware.
 */

import type { GatewayConfig } from "../../config.js";
import { fetchImpl } from "../../fetch.js";
import { getLogger } from "../../logger.js";

const log = getLogger("audio-proxy");

export function createAudioProxyHandler(config: GatewayConfig) {
  async function handleGetAudio(
    _req: Request,
    audioId: string,
  ): Promise<Response> {
    const upstream = `${config.assistantRuntimeBaseUrl}/v1/audio/${encodeURIComponent(audioId)}`;

    let response: Response;
    try {
      response = await fetchImpl(upstream, {
        method: "GET",
        signal: AbortSignal.timeout(config.runtimeTimeoutMs),
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "TimeoutError") {
        log.error({ audioId }, "Audio proxy upstream timed out");
        return Response.json({ error: "Gateway Timeout" }, { status: 504 });
      }
      log.error({ err, audioId }, "Audio proxy upstream connection failed");
      return Response.json({ error: "Bad Gateway" }, { status: 502 });
    }

    if (!response.ok) {
      // Pass through 404s and other errors from the daemon as-is
      const body = await response.text();
      return new Response(body, {
        status: response.status,
        headers: { "Content-Type": response.headers.get("Content-Type") ?? "application/json" },
      });
    }

    const headers: Record<string, string> = {
      "Content-Type": response.headers.get("Content-Type") ?? "application/octet-stream",
    };
    const contentLength = response.headers.get("Content-Length");
    if (contentLength) {
      headers["Content-Length"] = contentLength;
    }
    return new Response(response.body, {
      status: response.status,
      headers,
    });
  }

  return { handleGetAudio };
}
