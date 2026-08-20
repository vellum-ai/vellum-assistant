/**
 * `/v1/watch/stream`: a watch session's narration, proxied to the runtime.
 *
 * The client half of a watch session is a microphone and this socket
 * (`clients/web/src/domains/chat/watch/watch-controller.ts`); the runtime half
 * turns the narration into a timeline and decides when to read the user's
 * screen (`assistant/src/runtime/routes/watch-routes.ts`). Neither can reach
 * the other directly: the runtime is unreachable from outside the private
 * network, so this is the hop that makes the feature work from a browser at
 * all.
 *
 * The token gate and the frame pump are `runtime-audio-stream.ts`'s, shared
 * with `/v1/stt/stream`: the two carry different audio to different ends of
 * the runtime and are otherwise the same proxy, so they are one implementation
 * with two queries rather than two implementations that agree today.
 *
 * What is this route's own is who may open it. Watch is guardian-only and
 * dictation is not, so the pin below is layered here rather than added to the
 * shared gate, where it would take dictation with it.
 */

import {
  authorizeRuntimeAudioStream,
  createRuntimeAudioStreamHandlers,
  type RuntimeAudioStreamState,
} from "./runtime-audio-stream.js";
import {
  extractVelayAttestedContext,
  isPlatformManaged,
  requireBoundGuardian,
  requireManagedGuardian,
} from "./guardian-pin.js";
import type { GatewayConfig } from "../../config.js";
import { getLogger } from "../../logger.js";
import { requestHasVelayBridgeAuth } from "../../velay/bridge-auth.js";

const log = getLogger("watch-stream-ws");

export type WatchStreamSocketData = RuntimeAudioStreamState & {
  wsType: "watch-stream";
  /** MIME type of the narration audio (`audio/pcm` from the web capture). */
  mimeType: string;
  /** Sample rate in Hz, when applicable. */
  sampleRate?: number;
  /**
   * Conversation the session's timeline is filed against, when the client
   * names one. Absent lets the runtime mint a conversation for the session,
   * which is what the companion surface's Watch does: it starts a session
   * rather than joining a thread.
   */
  conversationId?: string;
  /**
   * Host client whose screen the session reads, when the client names one.
   * Absent lets the runtime resolve the actor's own host, which is the only
   * choice on a machine with one.
   */
  clientId?: string;
};

/**
 * Create the upgrade handler for `/v1/watch/stream`.
 *
 * Authenticates the downstream caller here and dials upstream with a
 * short-lived service token, which is what lets the runtime resolve the acting
 * principal from its own guardian rather than from anything the client sent.
 *
 * **Guardian-only, the way live voice is, and for a sharper reason.** The
 * daemon resolves whose screen to observe from the guardian binding and never
 * from the request, so a session opened by any other actor is still bound to
 * the guardian and still reads the guardian's screen. The proxy also replaces
 * the caller's identity with a service token upstream, leaving the daemon no
 * way to tell one actor from another. This upgrade is therefore the only place
 * a non-guardian actor can be refused, so it is refused here.
 */
export function createWatchStreamWebsocketHandler(config: GatewayConfig) {
  return async function handleUpgrade(
    req: Request,
    server: import("bun").Server<unknown>,
  ): Promise<Response | undefined> {
    // Checked here as well as in the shared gate, because the managed path
    // below skips that gate entirely: without this, a managed caller sending a
    // plain request would fall through to `server.upgrade` and get a 500.
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Upgrade Required", { status: 426 });
    }

    // Managed/cloud path, taken before the token path exactly as live voice
    // takes it: velay validated the browser's token and injected the caller,
    // and the bridge proof is what says this request really came through the
    // gateway's own loopback bridge rather than from someone who guessed the
    // header names. An incomplete attestation falls through, so a managed
    // deployment still accepts a valid actor edge JWT.
    let managedGuardian = false;
    if (isPlatformManaged() && config.runtimeProxyRequireAuth) {
      const velayContext = extractVelayAttestedContext(req);
      if (velayContext) {
        if (requestHasVelayBridgeAuth(req)) {
          const guardianError = await requireManagedGuardian(
            velayContext.userId,
            log,
          );
          if (guardianError) {
            return guardianError;
          }
          log.info(
            { userId: velayContext.userId, orgId: velayContext.orgId },
            "Watch stream WS: authenticated via velay-attested managed context",
          );
          managedGuardian = true;
        } else {
          log.warn(
            "Watch stream WS: ignoring velay context without bridge proof",
          );
        }
      }
    }

    // The token path, and its half of the pin. Skipped entirely when velay
    // already attested this caller as the guardian: there is no edge JWT on
    // that path to validate, and requiring one would reject the managed
    // callers the attestation exists to admit.
    if (!managedGuardian) {
      const auth = authorizeRuntimeAudioStream(req, config, log);
      if (!auth.ok) {
        return auth.response;
      }
      // A null principal is the dev bypass, which validated no token and has
      // nothing to compare. That bypass turns runtime proxy auth off
      // wholesale, and this is not the place to reintroduce it.
      if (auth.actorPrincipalId !== null) {
        const guardianError = await requireBoundGuardian(
          auth.actorPrincipalId,
          log,
        );
        if (guardianError) {
          return guardianError;
        }
      }
    }

    const url = new URL(req.url);
    const mimeType = url.searchParams.get("mimeType");
    if (!mimeType) {
      return new Response("Missing required query parameter: mimeType", {
        status: 400,
      });
    }

    const sampleRateRaw = url.searchParams.get("sampleRate");
    const sampleRate = sampleRateRaw ? parseInt(sampleRateRaw, 10) : undefined;
    const conversationId =
      url.searchParams.get("conversationId")?.trim() || undefined;
    const clientId = url.searchParams.get("clientId")?.trim() || undefined;

    const upgraded = server.upgrade(req, {
      data: {
        wsType: "watch-stream",
        config,
        mimeType,
        sampleRate,
        conversationId,
        clientId,
      } satisfies WatchStreamSocketData,
    });

    if (!upgraded) {
      return new Response("WebSocket upgrade failed", { status: 500 });
    }

    return undefined;
  };
}

/**
 * WebSocket handlers for Bun.serve() that pump narration audio to the
 * runtime's `/v1/watch/stream` and its lifecycle frames back.
 */
export function getWatchStreamWebsocketHandlers() {
  return createRuntimeAudioStreamHandlers<WatchStreamSocketData>({
    upstreamPath: "/v1/watch/stream",
    log,
    label: "watch stream",
    upstreamParams: ({ mimeType, sampleRate, conversationId, clientId }) => {
      const params: Record<string, string> = { mimeType };
      if (sampleRate !== undefined) {
        params.sampleRate = String(sampleRate);
      }
      if (conversationId) {
        params.conversationId = conversationId;
      }
      if (clientId) {
        params.clientId = clientId;
      }
      return params;
    },
    logContext: ({ mimeType, sampleRate, conversationId }) => ({
      mimeType,
      sampleRate,
      conversationId,
    }),
  });
}
