/**
 * The two halves every runtime audio-stream WebSocket proxy is made of: the
 * gate that decides whether a client may open one, and the pump that carries
 * frames between that client and the runtime.
 *
 * The gateway has more than one of these. `/v1/stt/stream` carries dictation
 * audio and `/v1/watch/stream` carries a watch session's narration, and as
 * proxies they are the same object: authenticate the downstream actor, dial a
 * fresh upstream socket with a short-lived service token, and pass frames
 * through in both directions until either end goes away. What differs is the
 * upstream path and which query parameters travel with it, which is why those
 * are the arguments here.
 *
 * **What the shared gate settles, and what it deliberately leaves open.** It
 * settles that the caller is *an* actor on this assistant: a valid edge JWT,
 * not revoked, carrying an actor principal, so a service credential cannot be
 * replayed into a client-facing socket. It does not settle whether that actor
 * is the one a particular surface belongs to, which is a question only the
 * route can answer. `/v1/watch/stream` answers it with `guardian-pin.ts`;
 * `/v1/stt/stream` answers that any actor will do. Adding the pin here would
 * take dictation with it.
 *
 * The upstream half carries only {@link mintServiceToken}, never anything the
 * client supplied: the runtime is unreachable from the public internet and
 * resolves the acting principal from its own guardian rather than from a
 * header this proxy could be talked into forwarding. That is also why the pin
 * matters, since it leaves the daemon unable to tell one caller from another.
 */

import type { Logger } from "pino";

import { buildWsUpstreamUrl } from "@vellumai/assistant-client";

import {
  validateEdgeToken,
  mintServiceToken,
} from "../../auth/token-exchange.js";
import { isActorTokenRevoked } from "../../auth/actor-token-revocation.js";
import { parseSub } from "../../auth/subject.js";
import type { GatewayConfig } from "../../config.js";

/**
 * Cap on frames held while the upstream socket is still connecting, so a
 * stalled runtime cannot grow this proxy's memory without bound.
 */
const MAX_PENDING_MESSAGES = 100;

/** The state every audio-stream proxy socket carries, whatever it streams. */
export interface RuntimeAudioStreamState {
  config: GatewayConfig;
  upstream?: WebSocket;
  pendingMessages?: (string | ArrayBuffer | Uint8Array)[];
}

/**
 * The outcome of the shared authorization: proceed, carrying whatever identity
 * it established, or send this response back instead.
 *
 * A response rather than a thrown error so the caller stays a plain upgrade
 * handler, which is the shape `Bun.serve` wants.
 *
 * `actorPrincipalId` is null only on the dev bypass, where no token was
 * validated and there is no principal to report. A route that pins the upgrade
 * to an identity has to decide what to do about that for itself; this module
 * takes no position, because the bypass exists precisely to run without one.
 */
export type RuntimeAudioStreamAuth =
  | { ok: true; actorPrincipalId: string | null }
  | { ok: false; response: Response };

/**
 * Whether a client may open one of these sockets.
 *
 * Establishes that the caller is *an* actor on this assistant and nothing
 * more. Whether they are the actor a particular surface belongs to is a
 * separate question, deliberately left to the route: see `guardian-pin.ts`,
 * which `/v1/watch/stream` opts into and `/v1/stt/stream` does not.
 */
export function authorizeRuntimeAudioStream(
  req: Request,
  config: GatewayConfig,
  log: Logger,
): RuntimeAudioStreamAuth {
  if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return {
      ok: false,
      response: new Response("Upgrade Required", { status: 426 }),
    };
  }

  // The dev bypass, which turns off runtime proxy auth globally. The upgrade
  // still has to be a well-formed one, so only token validation is skipped.
  if (!config.runtimeProxyRequireAuth) {
    return { ok: true, actorPrincipalId: null };
  }

  const authHeader = req.headers.get("authorization");
  const queryToken = new URL(req.url).searchParams.get("token");
  const rawToken = authHeader
    ? authHeader.toLowerCase().startsWith("bearer ")
      ? authHeader.slice(7)
      : null
    : queryToken;

  if (!rawToken) {
    log.warn("audio stream WS: no token provided");
    return {
      ok: false,
      response: new Response("Unauthorized", { status: 401 }),
    };
  }

  const result = validateEdgeToken(rawToken);
  if (!result.ok) {
    log.warn({ reason: result.reason }, "audio stream WS: auth failed");
    return {
      ok: false,
      response: new Response("Unauthorized", { status: 401 }),
    };
  }

  if (isActorTokenRevoked(rawToken, result.claims)) {
    log.warn("audio stream WS: rejected, actor token revoked");
    return {
      ok: false,
      response: new Response("Unauthorized", { status: 401 }),
    };
  }

  // An actor principal and nothing else. These are client-facing paths, and a
  // service token reaching one would let a credential minted for machine to
  // machine traffic open a user's microphone stream.
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
      "audio stream WS: denied token without actor principal",
    );
    return {
      ok: false,
      response: new Response("Unauthorized", { status: 401 }),
    };
  }

  return { ok: true, actorPrincipalId: parsed.actorPrincipalId };
}

export interface RuntimeAudioStreamHandlerOptions<
  T extends RuntimeAudioStreamState,
> {
  /** Runtime path this proxy dials, e.g. `/v1/stt/stream`. */
  upstreamPath: string;
  log: Logger;
  /** What this stream is called in log messages, e.g. `"STT stream"`. */
  label: string;
  /** Query parameters carried upstream, built from the socket's own state. */
  upstreamParams: (data: T) => Record<string, string>;
  /** Extra fields worth logging alongside every message about this socket. */
  logContext?: (data: T) => Record<string, unknown>;
}

/**
 * The `Bun.serve` WebSocket handlers that pump frames between a client and the
 * runtime.
 *
 * Frames that arrive before the upstream socket is open are buffered rather
 * than dropped: the client starts sending audio the moment its own socket
 * opens, and the first fraction of a second of speech is exactly the part a
 * transcriber needs most.
 */
export function createRuntimeAudioStreamHandlers<
  T extends RuntimeAudioStreamState,
>({
  upstreamPath,
  log,
  label,
  upstreamParams,
  logContext = () => ({}),
}: RuntimeAudioStreamHandlerOptions<T>) {
  return {
    open(ws: import("bun").ServerWebSocket<T>) {
      const context = logContext(ws.data);
      ws.data.pendingMessages = [];

      const { url: upstreamUrl, logSafeUrl: logSafeUpstreamUrl } =
        buildWsUpstreamUrl({
          baseUrl: ws.data.config.assistantRuntimeBaseUrl,
          path: upstreamPath,
          serviceToken: mintServiceToken(),
          extraParams: upstreamParams(ws.data),
        });

      log.info(
        { upstreamUrl: logSafeUpstreamUrl, ...context },
        `Opening upstream ${label} WS to runtime`,
      );

      const upstream = new WebSocket(upstreamUrl);
      ws.data.upstream = upstream;

      upstream.addEventListener("open", () => {
        log.info(context, `Upstream ${label} WS connected`);
        const pending = ws.data.pendingMessages;
        if (pending) {
          for (const msg of pending) {
            upstream.send(msg);
          }
          ws.data.pendingMessages = undefined;
        }
      });

      upstream.addEventListener("message", (event) => {
        // Runtime events back to the client.
        const data =
          typeof event.data === "string"
            ? event.data
            : new Uint8Array(event.data as ArrayBuffer);
        ws.send(data);
      });

      upstream.addEventListener("close", (event) => {
        log.info(
          { code: event.code, ...context },
          `Upstream ${label} WS closed`,
        );
        ws.close(event.code, event.reason);
      });

      upstream.addEventListener("error", (event) => {
        log.error({ error: event, ...context }, `Upstream ${label} WS error`);
        ws.close(1011, "Upstream error");
      });
    },

    message(
      ws: import("bun").ServerWebSocket<T>,
      message: string | ArrayBuffer | Uint8Array,
    ) {
      // Client audio frames on to the runtime.
      const upstream = ws.data.upstream;
      if (upstream && upstream.readyState === WebSocket.OPEN) {
        upstream.send(message);
        return;
      }
      if (ws.data.pendingMessages) {
        if (ws.data.pendingMessages.length >= MAX_PENDING_MESSAGES) {
          log.warn(`${label} pending message buffer overflow, closing`);
          ws.close(1008, "Buffer overflow");
          return;
        }
        ws.data.pendingMessages.push(message);
      }
    },

    close(ws: import("bun").ServerWebSocket<T>, code: number, reason: string) {
      const context = logContext(ws.data);
      log.info({ code, reason, ...context }, `${label} downstream WS closed`);
      ws.data.pendingMessages = undefined;
      const upstream = ws.data.upstream;
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
