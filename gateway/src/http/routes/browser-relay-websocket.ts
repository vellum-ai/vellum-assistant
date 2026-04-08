import {
  validateEdgeToken,
  mintServiceToken,
} from "../../auth/token-exchange.js";
import { parseSub } from "../../auth/subject.js";
import type { GatewayConfig } from "../../config.js";
import { getLogger } from "../../logger.js";
import { isLoopbackAddress } from "../../util/is-loopback-address.js";

const log = getLogger("browser-relay-ws");

// Cap buffered messages to prevent unbounded memory growth if upstream stalls
const MAX_PENDING_MESSAGES = 100;

function isPrivateAddress(addr: string): boolean {
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

function isPrivateNetworkPeer(
  server: import("bun").Server<unknown>,
  req: Request,
): boolean {
  const ip = server.requestIP(req);
  if (!ip) return false;
  return isPrivateAddress(ip.address);
}

export function isLoopbackPeer(
  server: import("bun").Server<unknown>,
  req: Request,
  opts?: { trustProxy?: boolean },
): boolean {
  if (opts?.trustProxy) {
    const forwarded = req.headers.get("x-forwarded-for");
    if (forwarded) {
      const first = forwarded.split(",")[0]?.trim();
      if (!first) return false;
      return isLoopbackAddress(first);
    }
  }

  const peer = server.requestIP(req);
  if (!peer) return false;
  return isLoopbackAddress(peer.address);
}

/**
 * Resolved auth context carried into the upstream WS open handler.
 *
 * `guardianId` is populated whenever the downstream edge token carries an
 * actor principal (i.e. the sub is `actor:<assistantId>:<actorPrincipalId>`).
 * Service tokens — which intentionally do not carry a guardian — will have
 * `guardianId === undefined` and are expected to be rejected at upstream
 * upgrade time unless an alternate guardian-plumbing path is wired up.
 */
export interface BrowserRelayAuthContext {
  guardianId?: string;
  /** True when auth was checked and succeeded. */
  authenticated: boolean;
  /** True when runtime proxy auth is globally disabled (dev bypass). */
  authBypassed: boolean;
}

export type BrowserRelaySocketData = {
  wsType: "browser-relay";
  config: GatewayConfig;
  auth: BrowserRelayAuthContext;
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

    const authResult = checkBrowserRelayAuth(req, url, config);
    if (!authResult.ok) return authResult.response;

    const upgraded = server.upgrade(req, {
      data: {
        wsType: "browser-relay",
        config,
        auth: authResult.context,
      },
    });

    if (!upgraded) {
      return new Response("WebSocket upgrade failed", { status: 500 });
    }

    // Return undefined to indicate upgrade was handled
    return undefined;
  };
}

type AuthCheckResult =
  | { ok: true; context: BrowserRelayAuthContext }
  | { ok: false; response: Response };

/**
 * Parse the downstream edge token and return a structured auth context.
 *
 * The gateway accepts the token via `Authorization: Bearer <jwt>` or a
 * `?token=` query parameter (browser WebSocket upgrades cannot set custom
 * headers, so the query param is the primary mechanism for the Chrome
 * extension). When the token carries an actor principal in its sub claim,
 * we propagate the `actorPrincipalId` forward as the guardian identity so
 * the runtime can register the connection under the correct guardian.
 */
export function checkBrowserRelayAuth(
  req: Request,
  url: URL,
  config: GatewayConfig,
): AuthCheckResult {
  if (!config.runtimeProxyRequireAuth) {
    return {
      ok: true,
      context: { authenticated: false, authBypassed: true },
    };
  }

  const authHeader = req.headers.get("authorization");
  const queryToken = url.searchParams.get("token");
  const rawToken = authHeader
    ? authHeader.toLowerCase().startsWith("bearer ")
      ? authHeader.slice(7)
      : null
    : queryToken;

  if (!rawToken) {
    log.warn("Browser relay WS: no token provided");
    return {
      ok: false,
      response: new Response("Unauthorized", { status: 401 }),
    };
  }

  const result = validateEdgeToken(rawToken);
  if (!result.ok) {
    log.warn(
      { reason: result.reason },
      "Browser relay WS: authentication failed",
    );
    return {
      ok: false,
      response: new Response("Unauthorized", { status: 401 }),
    };
  }

  const parsed = parseSub(result.claims.sub);
  let guardianId: string | undefined;
  if (
    parsed.ok &&
    parsed.principalType === "actor" &&
    parsed.actorPrincipalId
  ) {
    guardianId = parsed.actorPrincipalId;
  } else if (!parsed.ok) {
    // Not fatal — service tokens (svc:*:*) and unknown subs still reach
    // the runtime, where they are rejected if no guardian is available.
    log.debug(
      { reason: parsed.reason, sub: result.claims.sub },
      "Browser relay WS: edge token sub did not yield actor principal",
    );
  }

  return {
    ok: true,
    context: { authenticated: true, authBypassed: false, guardianId },
  };
}

/**
 * WebSocket handler config for Bun.serve() that proxies frames to runtime.
 */
export function getBrowserRelayWebsocketHandlers() {
  return {
    open(ws: import("bun").ServerWebSocket<BrowserRelaySocketData>) {
      const { config, auth } = ws.data;

      // Initialize message buffer for frames arriving before upstream connects
      ws.data.pendingMessages = [];

      const runtimeBase = config.assistantRuntimeBaseUrl.replace(/^http/, "ws");
      const upstreamToken = mintServiceToken();
      const query = new URLSearchParams({ token: upstreamToken });
      if (auth.guardianId) {
        query.set("guardianId", auth.guardianId);
      }
      const upstreamUrl = `${runtimeBase}/v1/browser-relay?${query.toString()}`;
      const logSafeUpstreamUrl =
        `${runtimeBase}/v1/browser-relay?token=<redacted>` +
        (auth.guardianId ? `&guardianId=${auth.guardianId}` : "");

      log.info(
        { upstreamUrl: logSafeUpstreamUrl, guardianId: auth.guardianId },
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
