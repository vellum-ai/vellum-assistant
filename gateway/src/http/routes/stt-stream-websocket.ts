import { buildWsUpstreamUrl } from "@vellumai/assistant-client";

import {
  validateEdgeToken,
  mintServiceToken,
} from "../../auth/token-exchange.js";
import { parseSub } from "../../auth/subject.js";
import type { GatewayConfig } from "../../config.js";
import { getLogger } from "../../logger.js";

const log = getLogger("stt-stream-ws");

// Cap buffered messages to prevent unbounded memory growth if upstream stalls
const MAX_PENDING_MESSAGES = 100;

export type SttStreamSocketData = {
  wsType: "stt-stream";
  config: GatewayConfig;
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
  upstream?: WebSocket;
  pendingMessages?: (string | ArrayBuffer | Uint8Array)[];
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
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Upgrade Required", { status: 426 });
    }

    const url = new URL(req.url);

    // ── Auth ──
    // STT streaming is an authenticated, assistant-scoped path. The
    // client must present a valid edge JWT (actor principal). There is
    // no auth-bypass mode — fail closed.
    if (!config.runtimeProxyRequireAuth) {
      // When runtime proxy auth is globally disabled (dev bypass), we
      // still allow the upgrade but skip token validation.
      const provider = url.searchParams.get("provider") ?? undefined;
      const mimeType = url.searchParams.get("mimeType");

      if (!mimeType) {
        return new Response("Missing required query parameter: mimeType", {
          status: 400,
        });
      }

      const sampleRateRaw = url.searchParams.get("sampleRate");
      const sampleRate = sampleRateRaw
        ? parseInt(sampleRateRaw, 10)
        : undefined;

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
      return undefined;
    }

    const authHeader = req.headers.get("authorization");
    const queryToken = url.searchParams.get("token");
    const rawToken = authHeader
      ? authHeader.toLowerCase().startsWith("bearer ")
        ? authHeader.slice(7)
        : null
      : queryToken;

    if (!rawToken) {
      log.warn("STT stream WS: no token provided");
      return new Response("Unauthorized", { status: 401 });
    }

    const result = validateEdgeToken(rawToken);
    if (!result.ok) {
      log.warn(
        { reason: result.reason },
        "STT stream WS: authentication failed",
      );
      return new Response("Unauthorized", { status: 401 });
    }

    // Require an actor principal — service tokens are not allowed on
    // this client-facing path.
    const parsed = parseSub(result.claims.sub);
    if (
      !parsed.ok ||
      parsed.principalType !== "actor" ||
      !parsed.actorPrincipalId
    ) {
      log.warn(
        {
          reason: parsed.ok ? "missing_actor_principal" : parsed.reason,
          sub: result.claims.sub,
        },
        "STT stream WS: denied token without actor principal",
      );
      return new Response("Unauthorized", { status: 401 });
    }

    // ── Query parameters ──
    // mimeType is required; provider is optional compatibility metadata
    // (the runtime resolves the transcriber from config, not from the query).
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
  return {
    open(ws: import("bun").ServerWebSocket<SttStreamSocketData>) {
      const { config, provider, mimeType, sampleRate } = ws.data;

      // Initialize message buffer for frames arriving before upstream connects
      ws.data.pendingMessages = [];

      const extraParams: Record<string, string> = { mimeType };
      if (provider) {
        extraParams.provider = provider;
      }
      if (sampleRate !== undefined) {
        extraParams.sampleRate = String(sampleRate);
      }
      const { url: upstreamUrl, logSafeUrl: logSafeUpstreamUrl } =
        buildWsUpstreamUrl({
          baseUrl: config.assistantRuntimeBaseUrl,
          path: "/v1/stt/stream",
          serviceToken: mintServiceToken(),
          extraParams,
        });

      log.info(
        { upstreamUrl: logSafeUpstreamUrl, provider, mimeType, sampleRate },
        "Opening upstream STT stream WS to runtime",
      );

      const upstream = new WebSocket(upstreamUrl);
      ws.data.upstream = upstream;

      upstream.addEventListener("open", () => {
        log.info({ provider }, "Upstream STT stream WS connected");
        const pending = ws.data.pendingMessages;
        if (pending) {
          for (const msg of pending) {
            upstream.send(msg);
          }
          ws.data.pendingMessages = undefined;
        }
      });

      upstream.addEventListener("message", (event) => {
        // Forward runtime transcription events -> client
        const data =
          typeof event.data === "string"
            ? event.data
            : new Uint8Array(event.data as ArrayBuffer);
        ws.send(data);
      });

      upstream.addEventListener("close", (event) => {
        log.info(
          { code: event.code, provider },
          "Upstream STT stream WS closed",
        );
        ws.close(event.code, event.reason);
      });

      upstream.addEventListener("error", (event) => {
        log.error({ error: event, provider }, "Upstream STT stream WS error");
        ws.close(1011, "Upstream error");
      });
    },

    message(
      ws: import("bun").ServerWebSocket<SttStreamSocketData>,
      message: string | ArrayBuffer | Uint8Array,
    ) {
      // Forward client audio frames -> runtime
      const upstream = ws.data.upstream;
      if (upstream && upstream.readyState === WebSocket.OPEN) {
        upstream.send(message);
      } else if (ws.data.pendingMessages) {
        if (ws.data.pendingMessages.length >= MAX_PENDING_MESSAGES) {
          log.warn(
            "STT stream pending message buffer overflow — closing connection",
          );
          ws.close(1008, "Buffer overflow");
          return;
        }
        ws.data.pendingMessages.push(message);
      }
    },

    close(
      ws: import("bun").ServerWebSocket<SttStreamSocketData>,
      code: number,
      reason: string,
    ) {
      const { upstream, provider } = ws.data;
      log.info({ code, reason, provider }, "STT stream downstream WS closed");
      ws.data.pendingMessages = undefined;
      if (
        upstream &&
        (upstream.readyState === WebSocket.OPEN ||
          upstream.readyState === WebSocket.CONNECTING)
      ) {
        upstream.close(code, reason);
      }
    },
  };
}
