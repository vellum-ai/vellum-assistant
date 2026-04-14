import {
  validateEdgeToken,
  mintServiceToken,
} from "../../auth/token-exchange.js";
import type { GatewayConfig } from "../../config.js";
import type { ConfigFileCache } from "../../config-file-cache.js";
import { getLogger } from "../../logger.js";

const log = getLogger("twilio-media-ws");

// Cap buffered messages to prevent unbounded memory growth if upstream stalls
const MAX_PENDING_MESSAGES = 100;

/** Path prefix for media-stream WS upgrades. */
const MEDIA_STREAM_PATH_PREFIX = "/webhooks/twilio/media-stream";

type MediaStreamSocketData = {
  wsType: "twilio-media-stream";
  callSessionId: string;
  assistantRuntimeBaseUrl: string;
  upstream?: WebSocket;
  pendingMessages?: (string | ArrayBuffer | Uint8Array)[];
};

export type { MediaStreamSocketData };

/**
 * Extract `callSessionId` and auth `token` from the request.
 *
 * **Primary path (new):** path segments after `/webhooks/twilio/media-stream/`.
 *   Format: `.../media-stream/<callSessionId>/<token>`
 *   Twilio Media Streams does not reliably preserve URL query parameters
 *   across the WebSocket upgrade, so path-segment encoding is the primary
 *   transport for handshake metadata.
 *
 * **Legacy fallback:** query parameters `callSessionId` and `token`.
 *   Supported for backward compatibility during rollout.
 */
export function extractMediaStreamMetadata(url: URL): {
  callSessionId: string | null;
  token: string | null;
} {
  // Try path-based extraction first.
  // Expected pathname: /webhooks/twilio/media-stream/<callSessionId>[/<token>]
  if (url.pathname.startsWith(MEDIA_STREAM_PATH_PREFIX + "/")) {
    const suffix = url.pathname.slice(MEDIA_STREAM_PATH_PREFIX.length + 1);
    const segments = suffix.split("/").filter(Boolean);
    if (segments.length >= 1) {
      try {
        const callSessionId = decodeURIComponent(segments[0]);
        const token =
          segments.length >= 2 ? decodeURIComponent(segments[1]) : null;
        return { callSessionId, token };
      } catch {
        // Malformed percent-encoding — fall through to query param fallback
      }
    }
  }

  // Fallback: query parameters (legacy)
  return {
    callSessionId: url.searchParams.get("callSessionId"),
    token: url.searchParams.get("token"),
  };
}

/**
 * Create a WebSocket upgrade handler that proxies Twilio Media Stream
 * frames between Twilio and the runtime's /v1/calls/media-stream endpoint.
 *
 * Uses the same edge-token auth model as the relay websocket upgrades.
 */
export function createTwilioMediaWebsocketHandler(
  config: GatewayConfig,
  caches?: { configFile?: ConfigFileCache },
) {
  return function handleUpgrade(
    req: Request,
    server: import("bun").Server<unknown>,
  ): Response | undefined {
    const url = new URL(req.url);
    const { callSessionId, token: pathToken } = extractMediaStreamMetadata(url);

    if (!callSessionId) {
      log.warn("Media stream WS upgrade without callSessionId");
      return new Response("Missing callSessionId", { status: 400 });
    }

    // Authenticate before upgrading. Twilio passes the token via path
    // segments (primary) or query parameters (legacy fallback) since
    // WebSocket upgrades don't support arbitrary headers.
    const isBypassed =
      process.env.APP_VERSION === "0.0.0-dev" &&
      (caches?.configFile?.getBoolean("telegram", "deliverAuthBypass") ??
        false);
    const authResponse = checkMediaStreamAuth(req, url, pathToken, isBypassed);
    if (authResponse) return authResponse;

    const upgraded = server.upgrade(req, {
      data: {
        wsType: "twilio-media-stream",
        callSessionId,
        assistantRuntimeBaseUrl: config.assistantRuntimeBaseUrl,
      } satisfies MediaStreamSocketData,
    });

    if (!upgraded) {
      return new Response("WebSocket upgrade failed", { status: 500 });
    }

    // Return undefined to indicate upgrade was handled
    return undefined;
  };
}

/**
 * Validate the media-stream WebSocket upgrade request using JWT edge tokens.
 *
 * Accepts a JWT via (in priority order):
 *   1. `Authorization: Bearer <token>` header (standard clients)
 *   2. Path-segment token extracted by {@link extractMediaStreamMetadata}
 *   3. `token` query parameter (legacy Twilio media streams fallback)
 *
 * Fail-closed: rejects all unauthenticated requests unless the deliver auth
 * bypass flag is set (local-dev only escape hatch).
 */
function checkMediaStreamAuth(
  req: Request,
  url: URL,
  pathToken: string | null,
  isBypassed: boolean,
): Response | null {
  // Local-dev bypass: allow unauthenticated access when deliverAuthBypass is set
  if (isBypassed) {
    return null;
  }

  // Priority: Authorization header > path segment > query param
  const authHeader = req.headers.get("authorization");
  const queryToken = url.searchParams.get("token");
  const rawToken = authHeader
    ? authHeader.toLowerCase().startsWith("bearer ")
      ? authHeader.slice(7)
      : null
    : (pathToken ?? queryToken);

  if (!rawToken) {
    log.warn("Media stream WS: no token provided");
    return new Response("Unauthorized", { status: 401 });
  }

  const result = validateEdgeToken(rawToken);
  if (!result.ok) {
    log.warn(
      { reason: result.reason },
      "Media stream WS: authentication failed",
    );
    return new Response("Unauthorized", { status: 401 });
  }

  return null;
}

/**
 * WebSocket handler config for Bun.serve() that proxies media-stream
 * frames to the runtime.
 */
export function getMediaStreamWebsocketHandlers() {
  return {
    open(ws: import("bun").ServerWebSocket<MediaStreamSocketData>) {
      const { callSessionId, assistantRuntimeBaseUrl } = ws.data;

      // Initialize message buffer for frames arriving before upstream connects
      ws.data.pendingMessages = [];

      // Build upstream URL to runtime with JWT service token for auth
      const runtimeBase = assistantRuntimeBaseUrl.replace(/^http/, "ws");
      const serviceToken = mintServiceToken();
      const upstreamUrl = `${runtimeBase}/v1/calls/media-stream?callSessionId=${encodeURIComponent(callSessionId)}&token=${encodeURIComponent(serviceToken)}`;

      const logSafeUpstreamUrl = `${runtimeBase}/v1/calls/media-stream?callSessionId=${encodeURIComponent(callSessionId)}&token=<redacted>`;
      log.info(
        { callSessionId, upstreamUrl: logSafeUpstreamUrl },
        "Opening upstream media-stream WS to runtime",
      );

      const upstream = new WebSocket(upstreamUrl);
      ws.data.upstream = upstream;

      upstream.addEventListener("open", () => {
        log.info({ callSessionId }, "Upstream media-stream WS connected");
        // Flush any buffered messages
        const pending = ws.data.pendingMessages;
        if (pending) {
          for (const msg of pending) {
            upstream.send(msg);
          }
          ws.data.pendingMessages = undefined;
        }
      });

      upstream.addEventListener("message", (event) => {
        // Forward runtime -> Twilio
        const data =
          typeof event.data === "string"
            ? event.data
            : new Uint8Array(event.data as ArrayBuffer);
        ws.send(data);
      });

      upstream.addEventListener("close", (event) => {
        log.info(
          { callSessionId, code: event.code },
          "Upstream media-stream WS closed",
        );
        ws.close(event.code, event.reason);
      });

      upstream.addEventListener("error", (event) => {
        log.error(
          { callSessionId, error: event },
          "Upstream media-stream WS error",
        );
        ws.close(1011, "Upstream error");
      });
    },

    message(
      ws: import("bun").ServerWebSocket<MediaStreamSocketData>,
      message: string | ArrayBuffer | Uint8Array,
    ) {
      // Forward Twilio -> runtime
      const upstream = ws.data.upstream;
      if (upstream && upstream.readyState === WebSocket.OPEN) {
        upstream.send(message);
      } else if (ws.data.pendingMessages) {
        // Buffer messages until upstream connects
        if (ws.data.pendingMessages.length >= MAX_PENDING_MESSAGES) {
          log.warn(
            { callSessionId: ws.data.callSessionId },
            "Media stream pending message buffer overflow — closing connection",
          );
          ws.close(1008, "Buffer overflow");
          return;
        }
        ws.data.pendingMessages.push(message);
      }
    },

    close(
      ws: import("bun").ServerWebSocket<MediaStreamSocketData>,
      code: number,
      reason: string,
    ) {
      const { callSessionId, upstream } = ws.data;
      log.info(
        { callSessionId, code, reason },
        "Twilio media-stream WS closed",
      );
      // Clear pending buffer so no messages are flushed after close
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
