import type { GatewayConfig } from "../../config.js";
import { getLogger } from "../../logger.js";
import { validateBearerToken } from "../auth/bearer.js";

const log = getLogger("browser-relay-ws");

// Cap buffered messages to prevent unbounded memory growth if upstream stalls
const MAX_PENDING_MESSAGES = 100;

export type BrowserRelaySocketData = {
  wsType: "browser-relay";
  config: GatewayConfig;
  clientToken?: string;
  upstream?: WebSocket;
  pendingMessages?: (string | ArrayBuffer | Uint8Array)[];
};

/**
 * Create a WebSocket upgrade handler that proxies browser-relay frames between
 * the local Chrome extension and the runtime's /v1/browser-relay endpoint.
 */
export function createBrowserRelayWebsocketHandler(config: GatewayConfig) {
  return function handleUpgrade(
    req: Request,
    server: import("bun").Server<unknown>,
  ): Response | undefined {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Upgrade Required", { status: 426 });
    }

    const url = new URL(req.url);

    const authResponse = checkBrowserRelayAuth(req, url, config);
    if (authResponse) return authResponse;

    const upgraded = server.upgrade(req, {
      data: {
        wsType: "browser-relay",
        config,
        clientToken: url.searchParams.get("token") ?? undefined,
      },
    });

    if (!upgraded) {
      return new Response("WebSocket upgrade failed", { status: 500 });
    }

    // Return undefined to indicate upgrade was handled
    return undefined;
  };
}

function checkBrowserRelayAuth(
  req: Request,
  url: URL,
  config: GatewayConfig,
): Response | null {
  if (!config.runtimeProxyRequireAuth) return null;

  if (!config.runtimeProxyBearerToken) {
    log.error("Browser relay WS: no bearer token configured — rejecting (fail-closed)");
    return new Response("Service not configured: bearer token required", { status: 503 });
  }

  const authHeader = req.headers.get("authorization");
  const queryToken = url.searchParams.get("token");
  const tokenSource = authHeader ?? (queryToken ? `Bearer ${queryToken}` : null);

  const result = validateBearerToken(tokenSource, config.runtimeProxyBearerToken);
  if (!result.authorized) {
    log.warn({ reason: result.reason }, "Browser relay WS: authentication failed");
    return new Response("Unauthorized", { status: 401 });
  }

  return null;
}

/**
 * WebSocket handler config for Bun.serve() that proxies frames to runtime.
 */
export function getBrowserRelayWebsocketHandlers() {
  return {
    open(ws: import("bun").ServerWebSocket<BrowserRelaySocketData>) {
      const { config } = ws.data;

      // Initialize message buffer for frames arriving before upstream connects
      ws.data.pendingMessages = [];

      const runtimeBase = config.assistantRuntimeBaseUrl.replace(/^http/, "ws");
      const upstreamToken = config.runtimeBearerToken || config.runtimeProxyBearerToken || ws.data.clientToken;
      const query = upstreamToken ? `?token=${encodeURIComponent(upstreamToken)}` : "";
      const upstreamUrl = `${runtimeBase}/v1/browser-relay${query}`;
      const logSafeUpstreamUrl = `${runtimeBase}/v1/browser-relay${upstreamToken ? "?token=<redacted>" : ""}`;

      log.info({ upstreamUrl: logSafeUpstreamUrl }, "Opening upstream browser relay WS to runtime");

      const upstream = new WebSocket(upstreamUrl);
      ws.data.upstream = upstream;

      upstream.addEventListener("open", () => {
        log.info("Upstream browser relay WS connected");
        const pending = ws.data.pendingMessages;
        if (pending) {
          for (const msg of pending) {
            upstream.send(msg);
          }
          ws.data.pendingMessages = undefined;
        }
      });

      upstream.addEventListener("message", (event) => {
        const data = typeof event.data === "string"
          ? event.data
          : new Uint8Array(event.data as ArrayBuffer);
        ws.send(data);
      });

      upstream.addEventListener("close", (event) => {
        log.info({ code: event.code }, "Upstream browser relay WS closed");
        ws.close(event.code, event.reason);
      });

      upstream.addEventListener("error", (event) => {
        log.error({ error: event }, "Upstream browser relay WS error");
        ws.close(1011, "Upstream error");
      });
    },

    message(
      ws: import("bun").ServerWebSocket<BrowserRelaySocketData>,
      message: string | ArrayBuffer | Uint8Array,
    ) {
      const upstream = ws.data.upstream;
      if (upstream && upstream.readyState === WebSocket.OPEN) {
        upstream.send(message);
      } else if (ws.data.pendingMessages) {
        if (ws.data.pendingMessages.length >= MAX_PENDING_MESSAGES) {
          log.warn("Browser relay pending message buffer overflow — closing connection");
          ws.close(1008, "Buffer overflow");
          return;
        }
        ws.data.pendingMessages.push(message);
      }
    },

    close(
      ws: import("bun").ServerWebSocket<BrowserRelaySocketData>,
      code: number,
      reason: string,
    ) {
      const { upstream } = ws.data;
      log.info({ code, reason }, "Browser relay downstream WS closed");
      ws.data.pendingMessages = undefined;
      if (upstream && (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING)) {
        upstream.close(code, reason);
      }
    },
  };
}
