/**
 * Live-voice WebSocket connection + transport routing.
 *
 * Live voice picks its transport by deployment kind via
 * {@link resolveLiveVoiceWsUrl}:
 *
 * - **Cloud** — streams audio to velay (`velay.vellum.ai`), which is
 *   cross-origin from the `platform.vellum.ai` SPA. A same-origin cookie WS
 *   upgrade is NOT viable: velay does no user auth, and the channel gateway
 *   only accepts a local actor edge JWT. So the browser first mints a
 *   short-lived, org+assistant-scoped WS token from the platform and passes it
 *   to velay as a `?token=` query param.
 * - **Self-hosted / local** — when {@link getSelfHostedIngressUrl} returns the
 *   user's gateway ingress, the browser connects directly to that gateway's
 *   `/v1/live-voice`, authenticated with the platform actor edge JWT
 *   ({@link getSelfHostedActorToken}) in `?token=`. velay is the cloud ingress
 *   only, so there is no token-exchange on this path — it mirrors how the
 *   self-hosted HeyAPI interceptor already routes runtime calls to the gateway.
 *
 * ---------------------------------------------------------------------------
 * Mint-endpoint contract (the backend plan must match this verbatim)
 * ---------------------------------------------------------------------------
 *
 *   POST /v1/auth/live-voice-token/
 *     Auth:     Django SessionAuthentication — session cookie + CSRF
 *               (`X-CSRFToken`) + `Vellum-Organization-Id`, all attached
 *               automatically by the platform HeyAPI client interceptor.
 *               Do NOT hand-roll an `Authorization` header.
 *     Request:  { assistantId: string }
 *     Response: { token: string; expiresAt: string }   // expiresAt is ISO-8601
 *
 * The endpoint scopes the minted token to the caller's active org and the
 * requested assistant; velay validates it on the WS upgrade.
 *
 * We call the generated platform SDK function `authLiveVoiceTokenCreate`, which
 * routes through the platform `client` — that interceptor attaches the session
 * cookie + CSRF + `Vellum-Organization-Id`.
 */

import { authLiveVoiceTokenCreate } from "@/generated/api/sdk.gen";
import type { LiveVoiceTokenResponse } from "@/generated/api/types.gen";
import {
  getSelfHostedActorToken,
  getSelfHostedIngressUrl,
} from "@/lib/self-hosted/connection";
import { assertHasResponse } from "@/utils/api-errors";

/** Production velay host (no scheme). Overridable via `VITE_VELAY_HOST`. */
const DEFAULT_VELAY_HOST = "velay.vellum.ai";

export class LiveVoiceTokenError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "LiveVoiceTokenError";
    this.status = status;
  }
}

/**
 * Type guard for the mint endpoint's wire shape. The SDK function is typed but
 * the body is unverified on the wire — narrow defensively rather than trusting
 * the generic.
 */
function isLiveVoiceToken(value: unknown): value is LiveVoiceTokenResponse {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.token === "string" && typeof v.expiresAt === "string";
}

/**
 * Mint a short-lived, org+assistant-scoped live-voice WS token.
 *
 * POSTs `/v1/auth/live-voice-token/` through the credentialed platform client
 * so the session cookie, CSRF token, and `Vellum-Organization-Id` ride along
 * automatically (see the module doc comment for the contract).
 */
export async function mintLiveVoiceToken(
  assistantId: string,
): Promise<LiveVoiceTokenResponse> {
  const { data, error, response } = await authLiveVoiceTokenCreate({
    body: { assistantId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to mint live-voice token");
  if (!response.ok) {
    throw new LiveVoiceTokenError(
      response.status,
      `Live-voice token request failed (HTTP ${response.status})`,
    );
  }
  if (!isLiveVoiceToken(data)) {
    throw new LiveVoiceTokenError(0, "Live-voice token response was malformed");
  }
  return data;
}

/** Resolve the velay host (no scheme), honouring the build-time override. */
function getVelayHost(): string {
  return import.meta.env.VITE_VELAY_HOST || DEFAULT_VELAY_HOST;
}

/**
 * Pick the WebSocket scheme for a velay host. Production velay is TLS (`wss`),
 * but the local `vel up` velay is plain HTTP on a loopback port
 * (`localhost:8501`), which a `wss` dial can't reach. Detect a loopback host and
 * downgrade to `ws` so local-dev (incl. cloud assistants tunnelled through the
 * local velay) works without TLS. Everything else stays `wss`.
 *
 * Exported for direct unit testing (the env-driven host resolution is separate).
 */
export function getVelayWsScheme(host: string): "ws" | "wss" {
  let hostname: string;
  try {
    ({ hostname } = new URL(`http://${host}`));
  } catch {
    return "wss";
  }
  const loopback =
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1";
  return loopback ? "ws" : "wss";
}

export interface BuildLiveVoiceWsUrlArgs {
  assistantId: string;
  /** Optional conversation to attach the live-voice session to. */
  conversationId?: string;
  /** Short-lived token from {@link mintLiveVoiceToken}. */
  token: string;
}

/**
 * Build the velay live-voice WebSocket URL for the cloud path:
 *
 *   wss://<velayHost>/<assistantId>/v1/live-voice?token=<token>[&conversationId=<id>]
 *
 * The scheme is `wss` for the real velay host and `ws` when `VITE_VELAY_HOST`
 * points at a loopback (local `vel up` velay) — see {@link getVelayWsScheme}.
 * The token is URL-encoded. `conversationId` is appended as an additional
 * query param only when provided.
 *
 * This is the cloud builder. The self-hosted/local path uses
 * {@link buildSelfHostedLiveVoiceWsUrl}; {@link resolveLiveVoiceWsUrl} chooses
 * between them.
 */
export function buildLiveVoiceWsUrl({
  assistantId,
  conversationId,
  token,
}: BuildLiveVoiceWsUrlArgs): string {
  const host = getVelayHost();
  const scheme = getVelayWsScheme(host);
  const url = new URL(`${scheme}://${host}/${assistantId}/v1/live-voice`);
  url.searchParams.set("token", token);
  if (conversationId) {
    url.searchParams.set("conversationId", conversationId);
  }
  return url.toString();
}

export interface BuildSelfHostedLiveVoiceWsUrlArgs {
  /**
   * The user's gateway ingress URL (e.g. `https://x.ngrok-free.app` or a plain
   * `http://localhost:{port}`), from {@link getSelfHostedIngressUrl}.
   */
  ingressUrl: string;
  /** Optional conversation to attach the live-voice session to. */
  conversationId?: string;
  /** Platform actor edge JWT from {@link getSelfHostedActorToken}. */
  token: string;
}

/**
 * Build the live-voice WebSocket URL for the self-hosted / local path:
 *
 *   ws(s)://<ingressHost>/v1/live-voice?token=<actorToken>[&conversationId=<id>]
 *
 * Differences from the cloud (velay) URL:
 * - **No `/<assistantId>` path prefix.** That prefix is velay's tunnel routing;
 *   the gateway serves `/v1/live-voice` directly.
 * - **Scheme follows the ingress:** `https`→`wss`, `http`→`ws`, so a plain-HTTP
 *   local gateway is reachable over `ws`.
 * - **The token is the actor edge JWT**, not a minted velay token. It rides in
 *   `?token=` because the browser WebSocket API can't set an `Authorization`
 *   header; the gateway's non-managed `checkLiveVoiceAuth` reads it there.
 *
 * The ingress *path prefix* is preserved and `/v1/live-voice` is appended to it
 * — in local Docker mode the gateway is reached at a path-based proxy
 * (`<origin>/assistant/__gateway/{port}`), exactly as the HTTP interceptor
 * (`rewriteForSelfHostedIngress`) splices it. Any query/hash on the ingress is
 * dropped.
 */
export function buildSelfHostedLiveVoiceWsUrl({
  ingressUrl,
  conversationId,
  token,
}: BuildSelfHostedLiveVoiceWsUrlArgs): string {
  const url = new URL(ingressUrl);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  const prefix = url.pathname.replace(/\/+$/, "");
  url.pathname = `${prefix}/v1/live-voice`;
  url.search = "";
  url.hash = "";
  url.searchParams.set("token", token);
  if (conversationId) {
    url.searchParams.set("conversationId", conversationId);
  }
  return url.toString();
}

export interface ResolveLiveVoiceWsUrlArgs {
  assistantId: string;
  /** Optional conversation to attach the live-voice session to. */
  conversationId?: string;
}

/**
 * Resolve the live-voice WebSocket URL for the current assistant, choosing the
 * transport by deployment kind (see the module doc comment):
 *
 * - **Self-hosted / local** — when {@link getSelfHostedIngressUrl} is primed,
 *   connect straight to the user's gateway with the actor edge JWT. No velay
 *   token-exchange happens. Throws {@link LiveVoiceTokenError} if the ingress is
 *   known but the actor token hasn't been provisioned yet (a brief post-hatch
 *   window), so the caller surfaces a connection failure rather than dialling an
 *   unauthenticated socket.
 * - **Cloud** — mint a short-lived velay WS token and build the velay URL.
 */
export async function resolveLiveVoiceWsUrl({
  assistantId,
  conversationId,
}: ResolveLiveVoiceWsUrlArgs): Promise<string> {
  const ingressUrl = getSelfHostedIngressUrl();
  if (ingressUrl) {
    const token = getSelfHostedActorToken();
    if (!token) {
      throw new LiveVoiceTokenError(
        0,
        "Self-hosted live voice has no actor token yet; the gateway isn't ready.",
      );
    }
    return buildSelfHostedLiveVoiceWsUrl({ ingressUrl, conversationId, token });
  }

  const { token } = await mintLiveVoiceToken(assistantId);
  return buildLiveVoiceWsUrl({ assistantId, conversationId, token });
}
