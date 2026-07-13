/**
 * Managed-speech relay: daemon → gateway → velay.
 *
 * The assistant daemon must never dial velay itself — velay contact is
 * gateway-only so deterministic policy stays in a process the agent cannot
 * rewrite. This route accepts a WebSocket from the daemon, dials velay's
 * speech relay (`/v1/speech/{stt,tts}/stream`) with the Vellum assistant
 * API key, and pipes frames verbatim in both directions. The wire protocol
 * on both legs is Deepgram's own (plus velay's `velay_error` control
 * frame), so the gateway stays byte-transparent.
 *
 * Contract mirrors velay's so the daemon adapter treats the gateway as a
 * drop-in relay endpoint:
 * - auth via `?key=` (a daemon-minted service JWT, NOT the assistant API
 *   key — the gateway attaches that to the upstream leg itself)
 * - rejections are JSON `{code, detail}` bodies
 * - upstream failures after upgrade surface as a synthesized
 *   `velay_error` text frame followed by an abnormal close
 * - a plain (non-upgrade) GET replays the gate and returns velay's own
 *   HTTP rejection, so the daemon's dial-failure probe works end-to-end
 */

import type { OutgoingHttpHeaders } from "node:http";

import { validateEdgeToken } from "../../auth/token-exchange.js";
import type { GatewayConfig } from "../../config.js";
import type { CredentialCache } from "../../credential-cache.js";
import { credentialKey } from "../../credential-key.js";
import { getLogger } from "../../logger.js";
import { VELAY_FORWARDED_HEADER } from "../../velay/bridge-utils.js";
import { requestHasVelayBridgeAuth } from "../../velay/bridge-auth.js";

const log = getLogger("speech-relay-ws");

/** Default relay origin when VELAY_BASE_URL is not configured. */
const DEFAULT_VELAY_BASE_URL = "https://velay.vellum.ai";

// Cap buffered messages to prevent unbounded memory growth if upstream stalls
const MAX_PENDING_MESSAGES = 100;

/**
 * The only principal allowed on this path: the daemon's self-minted
 * service token (both processes share the HMAC signing key). Duplicated in
 * the assistant's speech connection module — the packages don't share
 * auth constants.
 */
const DAEMON_SERVICE_SUB = "svc:daemon:self";

export type SpeechRelayOperation = "stt" | "tts";

/**
 * Param allowlists, mirroring velay's own (velay/internal/velay/deepgram.go).
 * Velay would reject unknown params anyway, but this relay is the policy
 * boundary — a buggy or compromised daemon must not get arbitrary query
 * strings forwarded upstream under the stored assistant API key.
 */
const ALLOWED_PARAMS: Record<SpeechRelayOperation, ReadonlySet<string>> = {
  stt: new Set([
    "encoding",
    "sample_rate",
    "channels",
    "language",
    "interim_results",
    "smart_format",
    "endpointing",
    "vad_events",
    "punctuate",
  ]),
  tts: new Set(["encoding", "sample_rate", "container"]),
};

type WebSocketConstructorWithHeaders = new (
  url: string,
  options?: { headers?: OutgoingHttpHeaders },
) => WebSocket;

export interface SpeechRelayDeps {
  credentials: CredentialCache;
  /** Injectable for tests — defaults to the global WebSocket. */
  webSocketConstructor?: WebSocketConstructorWithHeaders;
  /** Injectable for tests — defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export type SpeechRelaySocketData = {
  wsType: "speech-relay";
  operation: SpeechRelayOperation;
  /** wss URL of the velay speech endpoint, params already attached. */
  upstreamWsUrl: string;
  /** https twin of upstreamWsUrl, for failure probes. */
  upstreamHttpUrl: string;
  deps: SpeechRelayDeps;
  upstream?: WebSocket;
  upstreamOpened?: boolean;
  /**
   * Set by the close handler; open() re-checks it after its async
   * credential read so a daemon that hung up mid-read doesn't leave a
   * dialed velay session with no close left to forward.
   */
  downstreamClosed?: boolean;
  pendingMessages?: (string | ArrayBuffer | Uint8Array)[];
};

function jsonError(status: number, code: string, detail: string): Response {
  return new Response(JSON.stringify({ code, detail }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function velaySpeechUrls(
  config: GatewayConfig,
  operation: SpeechRelayOperation,
  params: URLSearchParams,
): { wsUrl: string; httpUrl: string } {
  // The velay tunnel client accepts ws(s):// bases too — normalize to the
  // http(s) twin first so the probe URL is always fetchable, then derive
  // the ws(s) dial URL from that.
  const httpBase = (config.velayBaseUrl ?? DEFAULT_VELAY_BASE_URL)
    .replace(/\/+$/, "")
    .replace(/^ws/, "http");
  const query = params.toString();
  const path = `/v1/speech/${operation}/stream${query ? `?${query}` : ""}`;
  return {
    httpUrl: `${httpBase}${path}`,
    wsUrl: `${httpBase.replace(/^http/, "ws")}${path}`,
  };
}

async function readAssistantApiKey(
  deps: SpeechRelayDeps,
): Promise<string | undefined> {
  return deps.credentials.get(credentialKey("vellum", "assistant_api_key"));
}

/**
 * Replay a failed/probing request against velay as plain HTTPS. Velay runs
 * its whole gate (key validation, params, balance, upstream dial) before
 * upgrading, so rejections reproduce as `{code, detail}` JSON; a request
 * that passes the gate fails only at the upgrade step, which returns no
 * such body.
 */
async function probeVelay(
  httpUrl: string,
  apiKey: string,
  fetchImpl: typeof fetch,
): Promise<{ status: number; code: string; detail: string } | null> {
  try {
    const res = await fetchImpl(httpUrl, {
      headers: { Authorization: `Api-Key ${apiKey}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (res.ok) {
      return null;
    }
    const body = (await res.json()) as { code?: unknown; detail?: unknown };
    if (typeof body.code !== "string") {
      return null;
    }
    return {
      status: res.status,
      code: body.code,
      detail: typeof body.detail === "string" ? body.detail : "",
    };
  } catch {
    return null;
  }
}

/**
 * Create the upgrade handler for one speech-relay path. Async: the
 * non-upgrade probe branch awaits velay.
 */
export function createSpeechRelayUpgradeHandler(
  config: GatewayConfig,
  operation: SpeechRelayOperation,
  deps: SpeechRelayDeps,
) {
  return async function handleUpgrade(
    req: Request,
    server: import("bun").Server<unknown>,
  ): Promise<Response | undefined> {
    if (req.method !== "GET") {
      return jsonError(405, "method_not_allowed", "GET only");
    }

    // This is a daemon-loopback service path. Anything that arrived
    // through velay's inbound tunnel (or the edge proxy) is categorically
    // rejected — the relay must never be reachable from outside.
    if (
      req.headers.get(VELAY_FORWARDED_HEADER) !== null ||
      requestHasVelayBridgeAuth(req)
    ) {
      log.warn("Speech relay: rejected velay-forwarded request");
      return jsonError(403, "forbidden", "not reachable via ingress");
    }

    const url = new URL(req.url);
    const params = url.searchParams;
    const rawToken = params.get("key");
    if (!rawToken) {
      return jsonError(401, "invalid_token", "missing service token");
    }
    const result = validateEdgeToken(rawToken);
    if (!result.ok || result.claims.sub !== DAEMON_SERVICE_SUB) {
      log.warn(
        { reason: result.ok ? "wrong_sub" : result.reason },
        "Speech relay: authentication failed",
      );
      return jsonError(401, "invalid_token", "service token rejected");
    }

    // ?key= is the daemon→gateway auth carrier, not a velay param.
    params.delete("key");
    for (const param of params.keys()) {
      if (!ALLOWED_PARAMS[operation].has(param)) {
        return jsonError(
          400,
          "invalid_request",
          `unsupported query parameter: ${param}`,
        );
      }
    }
    const { wsUrl, httpUrl } = velaySpeechUrls(config, operation, params);

    // Non-upgrade request: this is the daemon's dial-failure probe.
    // Replay the gate and hand back velay's own rejection.
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      const apiKey = await readAssistantApiKey(deps);
      if (!apiKey) {
        return jsonError(
          401,
          "missing_platform_connection",
          "no Vellum assistant API key is stored — connect the platform account",
        );
      }
      const rejection = await probeVelay(
        httpUrl,
        apiKey,
        deps.fetchImpl ?? fetch,
      );
      if (rejection) {
        return jsonError(rejection.status, rejection.code, rejection.detail);
      }
      return jsonError(
        426,
        "upgrade_required",
        "the gate passed; connect with a WebSocket upgrade",
      );
    }

    const upgraded = server.upgrade(req, {
      data: {
        wsType: "speech-relay",
        operation,
        upstreamWsUrl: wsUrl,
        upstreamHttpUrl: httpUrl,
        deps,
      } satisfies SpeechRelaySocketData,
    });
    if (!upgraded) {
      return jsonError(500, "upgrade_failed", "WebSocket upgrade failed");
    }
    return undefined;
  };
}

/** Send a velay_error control frame downstream (best-effort). */
function sendRelayError(
  ws: import("bun").ServerWebSocket<SpeechRelaySocketData>,
  code: string,
  detail: string,
): void {
  try {
    ws.send(JSON.stringify({ type: "velay_error", code, detail }));
  } catch {
    // The downstream socket may already be gone.
  }
}

/**
 * Bun.serve() websocket handlers for the speech relay: dial velay on open,
 * then pipe frames verbatim both ways. Upstream failures synthesize a
 * `velay_error` frame (probing velay for the real rejection) so the daemon
 * adapter's existing error mapping applies unchanged.
 */
export function getSpeechRelayWebsocketHandlers() {
  return {
    async open(ws: import("bun").ServerWebSocket<SpeechRelaySocketData>) {
      const { deps, upstreamWsUrl, upstreamHttpUrl, operation } = ws.data;
      ws.data.pendingMessages = [];
      ws.data.upstreamOpened = false;

      const apiKey = await readAssistantApiKey(deps);
      if (ws.data.downstreamClosed) {
        // The daemon hung up while the credential read was pending; there
        // is no close left to forward, so dialing now would leak a velay
        // session until its timeout.
        log.info({ operation }, "Speech relay: daemon closed before dial");
        return;
      }
      if (!apiKey) {
        log.warn({ operation }, "Speech relay: no assistant API key stored");
        sendRelayError(
          ws,
          "missing_platform_connection",
          "no Vellum assistant API key is stored — connect the platform account",
        );
        ws.close(1011, "missing_platform_connection");
        return;
      }

      const WsCtor = (deps.webSocketConstructor ??
        WebSocket) as WebSocketConstructorWithHeaders;
      const upstream = new WsCtor(upstreamWsUrl, {
        headers: { Authorization: `Api-Key ${apiKey}` },
      });
      // TTS audio arrives as binary frames; without this they surface as
      // Blobs and the downstream forward would crash.
      try {
        upstream.binaryType = "arraybuffer";
      } catch {
        // Test fakes may not implement the setter.
      }
      ws.data.upstream = upstream;

      // A rejected handshake can emit error and close (in either order,
      // sometimes both) before the async rejection probe resolves —
      // forwarding that raw close would beat the synthesized velay_error
      // frame to the daemon. Route every pre-open failure through one
      // guarded path instead.
      let dialFailureHandled = false;
      const handleDialFailure = () => {
        if (dialFailureHandled) {
          return;
        }
        dialFailureHandled = true;
        void probeVelay(upstreamHttpUrl, apiKey, deps.fetchImpl ?? fetch).then(
          (rejection) => {
            log.error(
              { operation, code: rejection?.code },
              "Speech relay upstream dial failed",
            );
            sendRelayError(
              ws,
              rejection?.code ?? "provider_unreachable",
              rejection?.detail ?? "could not reach the speech relay",
            );
            ws.close(1011, rejection?.code ?? "upstream_error");
          },
        );
      };

      upstream.addEventListener("open", () => {
        log.info({ operation }, "Speech relay upstream connected to velay");
        ws.data.upstreamOpened = true;
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
        if (!ws.data.upstreamOpened) {
          handleDialFailure();
          return;
        }
        log.info(
          { code: event.code, operation },
          "Speech relay upstream closed",
        );
        ws.close(event.code, event.reason);
      });

      upstream.addEventListener("error", () => {
        if (!ws.data.upstreamOpened) {
          handleDialFailure();
          return;
        }
        // Mid-session transport failure; velay already sent its own
        // velay_error frame if it had one.
        log.error({ operation }, "Speech relay upstream error");
        ws.close(1011, "upstream_error");
      });
    },

    message(
      ws: import("bun").ServerWebSocket<SpeechRelaySocketData>,
      message: string | ArrayBuffer | Uint8Array,
    ) {
      const upstream = ws.data.upstream;
      if (upstream && upstream.readyState === WebSocket.OPEN) {
        upstream.send(message);
      } else if (ws.data.pendingMessages) {
        if (ws.data.pendingMessages.length >= MAX_PENDING_MESSAGES) {
          log.warn(
            "Speech relay pending message buffer overflow — closing connection",
          );
          ws.close(1008, "Buffer overflow");
          return;
        }
        ws.data.pendingMessages.push(message);
      }
    },

    close(
      ws: import("bun").ServerWebSocket<SpeechRelaySocketData>,
      code: number,
      reason: string,
    ) {
      ws.data.downstreamClosed = true;
      const { upstream, operation } = ws.data;
      log.info({ code, reason, operation }, "Speech relay downstream closed");
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
