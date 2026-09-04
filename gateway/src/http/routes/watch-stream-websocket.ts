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
 * dictation is not, so the pin is opted into here rather than added to the
 * shared gate, where it would take dictation with it.
 */

import {
  createRuntimeAudioStreamHandlers,
  type RuntimeAudioStreamState,
} from "./runtime-audio-stream.js";
import { authorizeGuardianStream } from "./guardian-pin.js";
import type { GatewayConfig } from "../../config.js";
import { getLogger } from "../../logger.js";

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
  /**
   * The display the session reads, by `CGDirectDisplayID`, when the client
   * picked one. Carried verbatim: the runtime validates the pair and the host
   * honours it. Absent, with no window either, is the whole screen.
   */
  captureDisplayId?: number;
  /** The window the session reads, by `CGWindowID`, when the client picked one. */
  captureWindowId?: number;
};

/**
 * Read one capture id off the query string: absent or blank is no id, and
 * anything that is not a whole number is a request to refuse rather than
 * forward, since the runtime would refuse it too and a session opened on a
 * mangled id would read the whole screen while the client framed one window.
 */
function parseCaptureId(
  params: URLSearchParams,
  name: "captureDisplayId" | "captureWindowId",
): { value: number | undefined } | { error: string } {
  const raw = params.get(name)?.trim();
  if (!raw) {
    return { value: undefined };
  }
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    return { error: `${name} must be a whole number` };
  }
  return { value: Number(raw) };
}

/**
 * The upstream query for a socket: what the runtime's own upgrade handler
 * reads. The capture ids ride through untouched, since the frame the client
 * draws around what it picked is only honest if the runtime reads the same
 * thing. Exported for unit tests.
 */
export function watchStreamUpstreamParams(
  data: WatchStreamSocketData,
): Record<string, string> {
  const params: Record<string, string> = { mimeType: data.mimeType };
  if (data.sampleRate !== undefined) {
    params.sampleRate = String(data.sampleRate);
  }
  if (data.conversationId) {
    params.conversationId = data.conversationId;
  }
  if (data.clientId) {
    params.clientId = data.clientId;
  }
  if (data.captureDisplayId !== undefined) {
    params.captureDisplayId = String(data.captureDisplayId);
  }
  if (data.captureWindowId !== undefined) {
    params.captureWindowId = String(data.captureWindowId);
  }
  return params;
}

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
    const denied = await authorizeGuardianStream(req, config, log);
    if (denied) {
      return denied;
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
    const captureDisplay = parseCaptureId(url.searchParams, "captureDisplayId");
    if ("error" in captureDisplay) {
      return new Response(captureDisplay.error, { status: 400 });
    }
    const captureWindow = parseCaptureId(url.searchParams, "captureWindowId");
    if ("error" in captureWindow) {
      return new Response(captureWindow.error, { status: 400 });
    }
    if (
      captureDisplay.value !== undefined &&
      captureWindow.value !== undefined
    ) {
      return new Response(
        "captureDisplayId and captureWindowId are exclusive",
        { status: 400 },
      );
    }

    const upgraded = server.upgrade(req, {
      data: {
        wsType: "watch-stream",
        config,
        mimeType,
        sampleRate,
        conversationId,
        clientId,
        captureDisplayId: captureDisplay.value,
        captureWindowId: captureWindow.value,
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
    upstreamParams: watchStreamUpstreamParams,
    logContext: ({
      mimeType,
      sampleRate,
      conversationId,
      captureDisplayId,
      captureWindowId,
    }) => ({
      mimeType,
      sampleRate,
      conversationId,
      captureDisplayId,
      captureWindowId,
    }),
  });
}
