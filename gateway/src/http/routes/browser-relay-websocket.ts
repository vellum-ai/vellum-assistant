import {
  validateEdgeToken,
  mintServiceToken,
} from "../../auth/token-exchange.js";
import type { GatewayConfig } from "../../config.js";
import { getLogger } from "../../logger.js";

const log = getLogger("browser-relay-ws");

// Cap buffered messages to prevent unbounded memory growth if upstream stalls
const MAX_PENDING_MESSAGES = 100;

export function isPrivateAddress(addr: string): boolean {
  const v4Mapped = addr.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  const normalized = v4Mapped ? v4Mapped[1] : addr;

  if (normalized.includes(".")) {
    const parts = normalized.split(".").map(Number);
    if (
      parts.length !== 4 ||
      parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)
    )
      return false;

    if (parts[0] === 127) return true;
    if (parts[0] === 10) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;

    return false;
  }

  const lower = normalized.toLowerCase();
  if (lower === "::1") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  if (lower.startsWith("fe80")) return true;

  return false;
}

export function isPrivateNetworkPeer(
  server: import("bun").Server<unknown>,
  req: Request,
): boolean {
  const ip = server.requestIP(req);
  if (!ip) return false;
  return isPrivateAddress(ip.address);
}

/**
 * Stricter loopback-only check: accepts only 127.0.0.0/8 and ::1.
 * Use this instead of isPrivateNetworkPeer for endpoints that must be
 * restricted to the local machine (e.g. token minting).
 */
export function isLoopbackAddress(addr: string): boolean {
  const v4Mapped = addr.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  const normalized = v4Mapped ? v4Mapped[1] : addr;

  if (normalized.includes(".")) {
    const parts = normalized.split(".").map(Number);
    if (
      parts.length !== 4 ||
      parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)
    )
      return false;
    return parts[0] === 127;
  }

  return normalized.toLowerCase() === "::1";
}

export function isLoopbackPeer(
  server: import("bun").Server<unknown>,
  req: Request,
): boolean {
  const ip = server.requestIP(req);
  if (!ip) return false;
  return isLoopbackAddress(ip.address);
}

export type BrowserRelaySocketData = {
  wsType: "browser-relay";
  config: GatewayConfig;
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

    // Trust actual peer IP, not request host headers, for local/private gating.
    if (!isPrivateNetworkPeer(server, req)) {
      return new Response(
        "Browser relay only accepts connections from localhost",
        { status: 403 },
      );
    }

    const authResponse = checkBrowserRelayAuth(req, url, config);
    if (authResponse) return authResponse;

    const upgraded = server.upgrade(req, {
      data: {
        wsType: "browser-relay",
        config,
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

  // Accept JWT via Authorization header or query parameter (browser WebSocket
  // upgrades cannot set custom headers, so the token query param is the
  // primary mechanism for the Chrome extension).
  const authHeader = req.headers.get("authorization");
  const queryToken = url.searchParams.get("token");
  const rawToken = authHeader
    ? authHeader.toLowerCase().startsWith("bearer ")
      ? authHeader.slice(7)
      : null
    : queryToken;

  if (!rawToken) {
    log.warn("Browser relay WS: no token provided");
    return new Response("Unauthorized", { status: 401 });
  }

  const result = validateEdgeToken(rawToken);
  if (!result.ok) {
    log.warn(
      { reason: result.reason },
      "Browser relay WS: authentication failed",
    );
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
      const upstreamToken = mintServiceToken();
      const query = `?token=${encodeURIComponent(upstreamToken)}`;
      const upstreamUrl = `${runtimeBase}/v1/browser-relay${query}`;
      const logSafeUpstreamUrl = `${runtimeBase}/v1/browser-relay?token=<redacted>`;

      log.info(
        { upstreamUrl: logSafeUpstreamUrl },
        "Opening upstream browser relay WS to runtime",
      );

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
        const data =
          typeof event.data === "string"
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
          log.warn(
            "Browser relay pending message buffer overflow — closing connection",
          );
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
