import { buildWsUpstreamUrl } from "@vellumai/assistant-client";

import {
  validateEdgeToken,
  mintServiceToken,
} from "../../auth/token-exchange.js";
import { parseSub } from "../../auth/subject.js";
import type { GatewayConfig } from "../../config.js";
import { getLogger } from "../../logger.js";

const log = getLogger("live-voice-ws");

// Cap buffered messages to prevent unbounded memory growth if upstream stalls
const MAX_PENDING_MESSAGES = 100;

export type LiveVoiceSocketData = {
  wsType: "live-voice";
  config: GatewayConfig;
  upstream?: WebSocket;
  pendingMessages?: (string | ArrayBuffer | Uint8Array)[];
};

/**
 * Create a WebSocket upgrade handler that proxies live voice frames between
 * gateway clients and the runtime's /v1/live-voice endpoint.
 */
export function createLiveVoiceWebsocketHandler(config: GatewayConfig) {
  return function handleUpgrade(
    req: Request,
    server: import("bun").Server<unknown>,
  ): Response | undefined {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Upgrade Required", { status: 426 });
    }

    const url = new URL(req.url);
    const authResponse = checkLiveVoiceAuth(req, url, config);
    if (authResponse) return authResponse;

    const upgraded = server.upgrade(req, {
      data: {
        wsType: "live-voice",
        config,
      } satisfies LiveVoiceSocketData,
    });

    if (!upgraded) {
      return new Response("WebSocket upgrade failed", { status: 500 });
    }

    return undefined;
  };
}

function checkLiveVoiceAuth(
  req: Request,
  url: URL,
  config: GatewayConfig,
): Response | null {
  if (!config.runtimeProxyRequireAuth) {
    return null;
  }

  const authHeader = req.headers.get("authorization");
  const queryToken = url.searchParams.get("token");
  const rawToken = authHeader
    ? authHeader.toLowerCase().startsWith("bearer ")
      ? authHeader.slice(7)
      : null
    : queryToken;

  if (!rawToken) {
    log.warn("Live voice WS: no token provided");
    return new Response("Unauthorized", { status: 401 });
  }

  const result = validateEdgeToken(rawToken);
  if (!result.ok) {
    log.warn({ reason: result.reason }, "Live voice WS: authentication failed");
    return new Response("Unauthorized", { status: 401 });
  }

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
      "Live voice WS: denied token without actor principal",
    );
    return new Response("Unauthorized", { status: 401 });
  }

  return null;
}

/**
 * WebSocket handler config for Bun.serve() that opaquely proxies live voice
 * protocol and audio frames to the runtime.
 */
export function getLiveVoiceWebsocketHandlers() {
  return {
    open(ws: import("bun").ServerWebSocket<LiveVoiceSocketData>) {
      const { config } = ws.data;

      ws.data.pendingMessages = [];

      const { url: upstreamUrl, logSafeUrl: logSafeUpstreamUrl } =
        buildWsUpstreamUrl({
          baseUrl: config.assistantRuntimeBaseUrl,
          path: "/v1/live-voice",
          serviceToken: mintServiceToken(),
        });

      log.info(
        { upstreamUrl: logSafeUpstreamUrl },
        "Opening upstream live voice WS to runtime",
      );

      const upstream = new WebSocket(upstreamUrl);
      ws.data.upstream = upstream;

      upstream.addEventListener("open", () => {
        log.info("Upstream live voice WS connected");
        const pending = ws.data.pendingMessages;
        if (pending) {
          for (const msg of pending) {
            upstream.send(msg);
          }
          ws.data.pendingMessages = undefined;
        }
      });

      upstream.addEventListener("message", (event) => {
        const data =
          typeof event.data === "string"
            ? event.data
            : new Uint8Array(event.data as ArrayBuffer);
        ws.send(data);
      });

      upstream.addEventListener("close", (event) => {
        log.info({ code: event.code }, "Upstream live voice WS closed");
        ws.close(event.code, event.reason);
      });

      upstream.addEventListener("error", (event) => {
        log.error({ error: event }, "Upstream live voice WS error");
        ws.close(1011, "Upstream error");
      });
    },

    message(
      ws: import("bun").ServerWebSocket<LiveVoiceSocketData>,
      message: string | ArrayBuffer | Uint8Array,
    ) {
      const upstream = ws.data.upstream;
      if (upstream && upstream.readyState === WebSocket.OPEN) {
        upstream.send(message);
      } else if (ws.data.pendingMessages) {
        if (ws.data.pendingMessages.length >= MAX_PENDING_MESSAGES) {
          log.warn(
            "Live voice pending message buffer overflow — closing connection",
          );
          ws.close(1008, "Buffer overflow");
          return;
        }
        ws.data.pendingMessages.push(message);
      }
    },

    close(
      ws: import("bun").ServerWebSocket<LiveVoiceSocketData>,
      code: number,
      reason: string,
    ) {
      const { upstream } = ws.data;
      log.info({ code, reason }, "Live voice downstream WS closed");
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
