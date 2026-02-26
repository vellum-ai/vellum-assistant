import type { GatewayConfig } from "../../config.js";
import { getLogger } from "../../logger.js";
import { validateBearerToken } from "../auth/bearer.js";

const log = getLogger("twilio-relay-ws");

// Cap buffered messages to prevent unbounded memory growth if upstream stalls
const MAX_PENDING_MESSAGES = 100;

type RelaySocketData = {
  callSessionId: string;
  config: GatewayConfig;
  upstream?: WebSocket;
  pendingMessages?: (string | ArrayBuffer | Uint8Array)[];
};

/**
 * Create a WebSocket upgrade handler that proxies Twilio ConversationRelay
 * frames between Twilio and the runtime's /v1/calls/relay endpoint.
 */
export function createTwilioRelayWebsocketHandler(config: GatewayConfig) {
  return function handleUpgrade(req: Request, server: import("bun").Server<unknown>): Response | undefined {
    const url = new URL(req.url);
    const callSessionId = url.searchParams.get("callSessionId");

    if (!callSessionId) {
      log.warn("Relay WS upgrade without callSessionId");
      return new Response("Missing callSessionId", { status: 400 });
    }

    // Authenticate before upgrading. Twilio ConversationRelay passes the
    // token as a query parameter since WebSocket upgrades don't support
    // arbitrary headers.
    const authResponse = checkRelayAuth(req, url, config);
    if (authResponse) return authResponse;

    const upgraded = server.upgrade(req, {
      data: { callSessionId, config },
    });

    if (!upgraded) {
      return new Response("WebSocket upgrade failed", { status: 500 });
    }

    // Return undefined to indicate upgrade was handled
    return undefined;
  };
}

/**
 * Validate the relay WebSocket upgrade request.
 *
 * Accepts a bearer token via:
 *   1. `Authorization: Bearer <token>` header (standard clients)
 *   2. `token` query parameter (Twilio ConversationRelay — no custom headers)
 *
 * Fail-closed: rejects when no token is configured unless the SMS deliver
 * auth bypass flag is set (reusing the same local-dev escape hatch).
 */
function checkRelayAuth(
  req: Request,
  url: URL,
  config: GatewayConfig,
): Response | null {
  if (!config.runtimeProxyBearerToken) {
    if (config.smsDeliverAuthBypass) {
      return null;
    }
    log.error("Relay WS: no bearer token configured — rejecting (fail-closed)");
    return new Response("Service not configured: bearer token required", { status: 503 });
  }

  // Try Authorization header first, then fall back to query param
  const authHeader = req.headers.get("authorization");
  const queryToken = url.searchParams.get("token");

  const tokenSource = authHeader ?? (queryToken ? `Bearer ${queryToken}` : null);

  const result = validateBearerToken(tokenSource, config.runtimeProxyBearerToken);
  if (!result.authorized) {
    log.warn({ reason: result.reason }, "Relay WS: authentication failed");
    return new Response("Unauthorized", { status: 401 });
  }

  return null;
}

/**
 * WebSocket handler config for Bun.serve() that proxies frames to runtime.
 */
export function getRelayWebsocketHandlers() {
  return {
    open(ws: import("bun").ServerWebSocket<RelaySocketData>) {
      const { callSessionId, config } = ws.data;

      // Initialize message buffer for frames arriving before upstream connects
      ws.data.pendingMessages = [];

      // Build upstream URL to runtime
      const runtimeBase = config.assistantRuntimeBaseUrl.replace(/^http/, 'ws');
      const upstreamUrl = `${runtimeBase}/v1/calls/relay?callSessionId=${encodeURIComponent(callSessionId)}`;

      log.info({ callSessionId, upstreamUrl }, "Opening upstream WS to runtime");

      const upstream = new WebSocket(upstreamUrl);
      ws.data.upstream = upstream;

      upstream.addEventListener("open", () => {
        log.info({ callSessionId }, "Upstream WS connected");
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
        const data = typeof event.data === "string" ? event.data : new Uint8Array(event.data as ArrayBuffer);
        ws.send(data);
      });

      upstream.addEventListener("close", (event) => {
        log.info({ callSessionId, code: event.code }, "Upstream WS closed");
        ws.close(event.code, event.reason);
      });

      upstream.addEventListener("error", (event) => {
        log.error({ callSessionId, error: event }, "Upstream WS error");
        ws.close(1011, "Upstream error");
      });
    },

    message(ws: import("bun").ServerWebSocket<RelaySocketData>, message: string | ArrayBuffer | Uint8Array) {
      // Forward Twilio -> runtime
      const upstream = ws.data.upstream;
      if (upstream && upstream.readyState === WebSocket.OPEN) {
        upstream.send(message);
      } else if (ws.data.pendingMessages) {
        // Buffer messages until upstream connects
        if (ws.data.pendingMessages.length >= MAX_PENDING_MESSAGES) {
          log.warn({ callSessionId: ws.data.callSessionId }, "Pending message buffer overflow — closing connection");
          ws.close(1008, "Buffer overflow");
          return;
        }
        ws.data.pendingMessages.push(message);
      }
    },

    close(ws: import("bun").ServerWebSocket<RelaySocketData>, code: number, reason: string) {
      const { callSessionId, upstream } = ws.data;
      log.info({ callSessionId, code, reason }, "Twilio WS closed");
      // Clear pending buffer so no messages are flushed after close
      ws.data.pendingMessages = undefined;
      if (upstream && (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING)) {
        upstream.close(code, reason);
      }
    },
  };
}
