import { buildWsUpstreamUrl } from "@vellumai/assistant-client";

import {
  validateEdgeToken,
  mintServiceToken,
} from "../../auth/token-exchange.js";
import { isActorTokenRevoked } from "../../auth/actor-token-revocation.js";
import { findVellumGuardian } from "../../auth/guardian-bootstrap.js";
import { parseSub } from "../../auth/subject.js";
import type { GatewayConfig } from "../../config.js";
import { getLogger } from "../../logger.js";
import { requestHasVelayBridgeAuth } from "../../velay/bridge-auth.js";

const log = getLogger("live-voice-ws");

// Cap buffered messages to prevent unbounded memory growth if upstream stalls
const MAX_PENDING_MESSAGES = 100;

// ---------------------------------------------------------------------------
// Velay-attested managed auth headers
// ---------------------------------------------------------------------------
//
// In managed/cloud deployments, velay validates the browser's live-voice
// wsToken, strips any client-supplied copies of these headers, and injects the
// authenticated caller context into the tunnel frame. The gateway only trusts
// that context when the loopback WebSocket open also carries the process-local
// bridge proof injected by this gateway's VelayWebSocketBridge; IS_PLATFORM
// alone is not a per-request proof that the caller traversed velay.
const VELAY_USER_ID_HEADER = "x-velay-user-id";
const VELAY_ORG_ID_HEADER = "x-velay-org-id";
const VELAY_ACTOR_HEADER = "x-velay-actor";

/**
 * True when the gateway runs in managed/cloud mode (vembda + velay ingress).
 * Mirrors the `IS_PLATFORM` check used by the gateway's HTTP edge auth
 * (`src/http/middleware/auth.ts`) and feature-flag resolver.
 */
function isPlatformManaged(): boolean {
  const v = process.env.IS_PLATFORM?.trim().toLowerCase();
  return v === "1" || v === "true";
}

/** Velay-attested managed caller context, extracted from injected headers. */
type VelayAttestedContext = {
  userId: string;
  orgId: string;
};

/**
 * Extract a velay-attested managed caller context from the upgrade request.
 *
 * Returns null when the request does not carry a complete, well-formed velay
 * attestation (`X-Velay-User-Id` + `X-Velay-Org-Id` both present, with
 * `X-Velay-Actor: user`). Callers MUST only trust the result in managed mode.
 */
function extractVelayAttestedContext(
  req: Request,
): VelayAttestedContext | null {
  const userId = req.headers.get(VELAY_USER_ID_HEADER)?.trim();
  const orgId = req.headers.get(VELAY_ORG_ID_HEADER)?.trim();
  const actor = req.headers.get(VELAY_ACTOR_HEADER)?.trim().toLowerCase();

  if (!userId || !orgId || actor !== "user") {
    return null;
  }
  return { userId, orgId };
}

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
  return async function handleUpgrade(
    req: Request,
    server: import("bun").Server<unknown>,
  ): Promise<Response | undefined> {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Upgrade Required", { status: 426 });
    }

    const url = new URL(req.url);
    const authResponse = await checkLiveVoiceAuth(req, url, config);
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

async function checkLiveVoiceAuth(
  req: Request,
  url: URL,
  config: GatewayConfig,
): Promise<Response | null> {
  if (!config.runtimeProxyRequireAuth) {
    return null;
  }

  // Managed/cloud path: velay validates the browser wsToken and injects
  // X-Velay-* context into the tunnel frame. Trust it only when this request
  // also has the process-local proof injected by the gateway's own loopback
  // bridge. A direct request to a reachable gateway can spoof X-Velay-* names,
  // but cannot know the bridge proof value.
  if (isPlatformManaged()) {
    const velayContext = extractVelayAttestedContext(req);
    if (velayContext) {
      if (requestHasVelayBridgeAuth(req)) {
        log.info(
          { userId: velayContext.userId, orgId: velayContext.orgId },
          "Live voice WS: authenticated via velay-attested managed context",
        );
        return null;
      }
      log.warn("Live voice WS: ignoring velay context without bridge proof");
    }
    // No (or incomplete) velay attestation — fall through to the actor-JWT
    // path below so a managed deployment still accepts a valid actor edge JWT.
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

  if (isActorTokenRevoked(rawToken, result.claims)) {
    log.warn("Live voice WS: rejected — actor token revoked");
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

  // Live voice is a guardian-only surface: the room runs in the owner's own
  // client, and the daemon stamps each voice turn with the guardian's trust
  // context on that basis — so pin the upgrade to the bound guardian, the same
  // check the guardian edge-auth middleware applies to guardian-only HTTP
  // routes. Any valid-but-non-guardian actor token is rejected here rather
  // than reaching the daemon with an identity the voice path can't represent.
  let guardian: { principalId: string } | null;
  try {
    guardian = await findVellumGuardian();
  } catch (err) {
    log.error({ err }, "Live voice WS: findVellumGuardian failed");
    return new Response("Service Unavailable", { status: 503 });
  }
  if (!guardian || guardian.principalId !== parsed.actorPrincipalId) {
    log.warn("Live voice WS: rejected — caller is not the bound guardian");
    return new Response("Forbidden", { status: 403 });
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
