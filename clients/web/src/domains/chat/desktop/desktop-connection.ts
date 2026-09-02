/**
 * Transport for the pod desktop stream: which URL to dial, and what the
 * socket's close code means once it is gone.
 *
 * `/v1/desktop/stream` is a pure RFB byte pipe. Session start is implicit in
 * the upgrade, teardown starts when the socket closes, and the runtime speaks
 * to the client only through WebSocket close codes. There are no JSON control
 * frames on this socket: noVNC's `Websock` treats it as RFB-only and a text
 * frame would corrupt the stream.
 *
 * The URL is chosen by deployment kind exactly as watch and live voice choose
 * theirs (`watch-controller.ts`, `live-voice/connection.ts`): a self-hosted
 * assistant is dialled straight at the user's gateway ingress with the actor
 * edge JWT in `?token=`, and a managed one is dialled through velay with a
 * short-lived minted token. A paired assistant has no WebSocket transport at
 * all (its proxy is HTTP-only), so it is refused up front rather than left to
 * hang on a socket that never opens.
 */

import {
  buildSelfHostedGatewayWsUrl,
  buildVelayWsUrl,
  isPairedGatewayIngress,
  mintVelayWsToken,
  PairedVoiceUnavailableError,
  VelayWsTokenError,
} from "@/domains/chat/voice/live-voice/connection";
import {
  getSelfHostedActorToken,
  getSelfHostedIngressUrl,
} from "@/lib/self-hosted/connection";

/** The route both transports open, on the gateway either way. */
export const DESKTOP_STREAM_ROUTE = "/v1/desktop/stream";

/**
 * Close codes the runtime uses to refuse or end a desktop session. Part of
 * the cross-service contract; the gateway relays them verbatim.
 */
export const DESKTOP_CLOSE_BUSY = 1013;
export const DESKTOP_CLOSE_FAILED = 1011;
export const DESKTOP_CLOSE_UNAVAILABLE = 1008;

/**
 * Why a desktop session is over, as the panel explains it.
 *
 * - `busy`: another viewer holds the single session slot.
 * - `unavailable`: the assistant cannot serve a desktop (flag off, not a
 *   containerized pod, or a paired deployment with no WebSocket transport).
 * - `failed`: the desktop did not start, or the handshake was refused.
 * - `lost`: anything else, which is a connection worth retrying.
 */
export type DesktopEndReason = "busy" | "unavailable" | "failed" | "lost";

/** Map a WebSocket close code to the reason the panel shows for it. */
export function desktopEndReasonForClose(code: number): DesktopEndReason {
  switch (code) {
    case DESKTOP_CLOSE_BUSY:
      return "busy";
    case DESKTOP_CLOSE_UNAVAILABLE:
      return "unavailable";
    case DESKTOP_CLOSE_FAILED:
      return "failed";
    default:
      return "lost";
  }
}

/** The reason a URL that could not be resolved leaves the panel with. */
export function desktopEndReasonForResolveError(
  err: unknown,
): DesktopEndReason {
  return err instanceof PairedVoiceUnavailableError ? "unavailable" : "failed";
}

/**
 * Build the self-hosted desktop stream WebSocket URL:
 *
 *   ws(s)://<ingressHost>/v1/desktop/stream?token=…
 *
 * Through the same helper as the audio streams, so every gateway WebSocket
 * the browser opens follows one idea of how to reach the gateway. Exported
 * for unit tests.
 */
export function buildDesktopStreamWsUrl({
  ingressUrl,
  token,
}: {
  ingressUrl: string;
  token: string;
}): string {
  return buildSelfHostedGatewayWsUrl({
    ingressUrl,
    routePath: DESKTOP_STREAM_ROUTE,
    token,
  });
}

/**
 * Resolve the desktop stream WebSocket URL for `assistantId`, choosing the
 * transport by deployment kind exactly as `resolveWatchStreamWsUrl` does.
 *
 * Throws rather than returning null, so a panel that cannot resolve a URL can
 * say why:
 *
 * - {@link PairedVoiceUnavailableError} for a paired ingress, which has no
 *   WebSocket transport.
 * - {@link VelayWsTokenError} when the ingress is known but its actor token
 *   has not been provisioned yet (a brief post-hatch window), and for a mint
 *   the platform refuses.
 */
export async function resolveDesktopStreamWsUrl(
  assistantId: string,
): Promise<string> {
  const ingressUrl = getSelfHostedIngressUrl();
  if (ingressUrl) {
    if (isPairedGatewayIngress(ingressUrl)) {
      throw new PairedVoiceUnavailableError();
    }
    const token = getSelfHostedActorToken();
    if (!token) {
      throw new VelayWsTokenError(
        0,
        "Self-hosted desktop has no actor token yet; the gateway isn't ready.",
      );
    }
    return buildDesktopStreamWsUrl({ ingressUrl, token });
  }

  const { token } = await mintVelayWsToken(assistantId);
  return buildVelayWsUrl({
    assistantId,
    routePath: DESKTOP_STREAM_ROUTE,
    token,
  });
}
