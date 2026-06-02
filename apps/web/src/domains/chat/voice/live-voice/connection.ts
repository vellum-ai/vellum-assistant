/**
 * Live-voice WebSocket connection + token-exchange client.
 *
 * Live voice streams audio to velay (`velay.vellum.ai`), which is cross-origin
 * from the `platform.vellum.ai` SPA. A same-origin cookie WS upgrade is NOT
 * viable: velay does no user auth, and the channel gateway only accepts a
 * local actor edge JWT. So the browser must first mint a short-lived,
 * org+assistant-scoped WS token from the platform and pass it to velay as a
 * `?token=` query param.
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
 * No generated SDK function exists for this route yet (the OpenAPI regen
 * hasn't picked it up — the backend endpoint is a separate plan). We call
 * `client.post` directly with the URL, matching sibling hand-rolled platform
 * fetchers (e.g. `domains/chat/inspector/compaction-trail-fetch.ts`). Routing
 * through the platform `client` is what attaches the session cookie + CSRF +
 * `Vellum-Organization-Id` via the request interceptor.
 */

import { client } from "@/generated/api/client.gen";
import { assertHasResponse } from "@/utils/api-errors";

/** Production velay host (no scheme). Overridable via `VITE_VELAY_HOST`. */
const DEFAULT_VELAY_HOST = "velay.vellum.ai";

export interface LiveVoiceToken {
  token: string;
  /** ISO-8601 timestamp after which the token is no longer accepted by velay. */
  expiresAt: string;
}

export class LiveVoiceTokenError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "LiveVoiceTokenError";
    this.status = status;
  }
}

/**
 * Type guard for the mint endpoint's wire shape. `client.post` is typed but
 * the body is `unknown` on the wire — narrow defensively rather than trusting
 * the generic.
 */
function isLiveVoiceToken(value: unknown): value is LiveVoiceToken {
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
): Promise<LiveVoiceToken> {
  const { data, error, response } = await client.post<LiveVoiceToken, unknown>({
    url: "/v1/auth/live-voice-token/",
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
 * The token is URL-encoded. `conversationId` is appended as an additional
 * query param only when provided.
 *
 * TODO(self-hosted): when `getSelfHostedIngressUrl()` (see
 * `@/lib/self-hosted/connection`) returns a local gateway URL, live voice
 * should instead connect to that gateway over plain WS
 * (`ws://localhost:{port}/...`) authenticated with a `Bearer` actor token,
 * rather than to velay with a minted query token. Not implemented — cloud is
 * the target for this plan, so this builder is cloud-only for now.
 */
export function buildLiveVoiceWsUrl({
  assistantId,
  conversationId,
  token,
}: BuildLiveVoiceWsUrlArgs): string {
  const host = getVelayHost();
  const url = new URL(`wss://${host}/${assistantId}/v1/live-voice`);
  url.searchParams.set("token", token);
  if (conversationId) {
    url.searchParams.set("conversationId", conversationId);
  }
  return url.toString();
}
