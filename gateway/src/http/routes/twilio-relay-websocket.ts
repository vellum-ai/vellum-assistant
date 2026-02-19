import type { GatewayConfig } from "../../config.js";
import { getLogger } from "../../logger.js";

const log = getLogger("twilio-relay-ws");

// Cap buffered messages to prevent unbounded memory growth if upstream stalls
const MAX_PENDING_MESSAGES = 100;

/**
 * Create a WebSocket upgrade handler that proxies Twilio ConversationRelay
 * frames between Twilio and the runtime's /v1/calls/relay endpoint.
 */
export function createTwilioRelayWebsocketHandler(config: GatewayConfig) {
  return function handleUpgrade(req: Request, server: import("bun").Server): Response | undefined {
    const url = new URL(req.url);
    const callSessionId = url.searchParams.get("callSessionId");

    if (!callSessionId) {
      log.warn("Relay WS upgrade without callSessionId");
      return new Response("Missing callSessionId", { status: 400 });
    }

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

type RelaySocketData = {
  callSessionId: string;
  config: GatewayConfig;
  upstream?: WebSocket;
  pendingMessages?: (string | ArrayBuffer | Uint8Array)[];
};

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
        if (ws.data.pendingMessages.length >= MAX_PENDING_MESSAGES) {
          log.warn({ callSessionId: ws.data.callSessionId }, "Pending message buffer full, closing connection");
          ws.close(1011, "Buffer overflow");
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
