/**
 * Request/response interceptors for the generated HeyAPI clients.
 *
 * For platform-bound requests, attaches:
 *   - `Vellum-Organization-Id` — selects the active org server-side.
 *   - `X-CSRFToken` (mutations only) — required by Django's
 *     SessionAuthentication.
 *   - `X-Vellum-Client-Id` + `X-Vellum-Interface-Id` — identify the
 *     originating tab/interface to the daemon. Required by self-echo
 *     suppression: the daemon echoes the client id back on the resulting
 *     `sync_changed` so the originator's SSE subscriber can be skipped.
 *
 * When `getSelfHostedIngressUrl()` returns a URL AND the request hits a
 * runtime-proxied per-assistant path, {@link rewriteForSelfHostedIngress}
 * takes over instead — the URL's origin is swapped to the ingress, the
 * platform-only headers are stripped, cookie credentials are omitted,
 * and an `Authorization: Bearer` is attached when
 * `getSelfHostedActorToken()` returns a value (it can briefly return
 * `null` while `bootstrap_platform_actor_token` is mid-flight on the
 * platform — the gateway then 401s and the chat surface lands on its
 * error state).
 *
 * Import this module for its side effects in the app entrypoint
 * (`main.tsx`) so interceptors are installed before any API call fires.
 *
 * Reference: https://heyapi.dev/openapi-ts/clients/fetch#interceptors
 */
import { client as platformClient } from "@/generated/api/client.gen";
import { client as authClient } from "@/generated/auth/client.gen";
import { client as daemonClient } from "@/generated/daemon/client.gen";
import { ensureCsrfCookie, getCsrfToken } from "@/lib/auth/csrf";
import { isLocalMode } from "@/lib/local-mode";
import {
  getSelfHostedActorToken,
  getSelfHostedIngressUrl,
} from "@/lib/self-hosted/connection";
import { getClientRegistrationHeaders } from "@/lib/telemetry/client-identity";
import { isElectron } from "@/runtime/is-electron";
import { getElectronSessionToken } from "@/runtime/session-token";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { getActiveOrganizationIdForRequests } from "@/stores/organization-store";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const ELECTRON_RENDERER_ORIGIN_HEADER = "X-Vellum-Electron-Renderer-Origin";

function getRendererTupleOrigin(): string {
  return `${window.location.protocol}//${window.location.host}`;
}

/**
 * Allowlist of `/v1/assistants/{id}/<segment>/...` first segments that
 * the **platform client** rewrites to the self-hosted gateway.
 *
 * Only applies to requests made through the platform HeyAPI client.
 * The daemon client bypasses this list entirely — all daemon SDK
 * requests are forwarded to the gateway unconditionally (see
 * {@link daemonRequestInterceptor}).
 *
 * Kept narrow for the platform client: the platform owns routes like
 * `maintenance-mode/`, `system-events/`, `terminal/`, `doctor/` under
 * the same namespace, and forwarding those to the gateway would 404.
 * Once all daemon endpoints are migrated to the daemon SDK, this list
 * becomes dead code and can be removed.
 */
const RUNTIME_PROXIED_FIRST_SEGMENTS = new Set<string>(["conversations"]);

const ASSISTANT_PATH_RE =
  /^\/v1\/assistants\/[^/]+\/([^/?#]+)(?:\/.*)?$/;

/**
 * Rewrites a request bound for `/v1/assistants/{id}/{runtime-segment}/...`
 * to the registered self-hosted ingress, swapping platform session/CSRF
 * auth for `Authorization: Bearer <jwt>`.
 *
 * Returns `null` when no self-hosted ingress is currently set or when
 * the path doesn't match an assistant sub-resource.
 *
 * @param request — the outbound request to inspect.
 * @param options.skipSegmentAllowlist — when `true`, all assistant
 *   sub-resource paths are forwarded regardless of
 *   {@link RUNTIME_PROXIED_FIRST_SEGMENTS}. The daemon client sets this
 *   because every daemon SDK endpoint is a daemon route by definition.
 *   The platform client leaves it `false` to avoid forwarding
 *   platform-owned routes (maintenance-mode, system-events, etc.).
 *
 * Exported for direct unit testing — production code paths invoke this
 * via {@link requestInterceptor} / {@link daemonRequestInterceptor}.
 */
export async function rewriteForSelfHostedIngress(
  request: Request,
  { skipSegmentAllowlist = false } = {},
): Promise<Request | null> {
  const ingressUrl = getSelfHostedIngressUrl();
  if (!ingressUrl) return null;

  const url = new URL(request.url);

  const match = ASSISTANT_PATH_RE.exec(url.pathname);
  if (!match) return null;
  const firstSegment = match[1];
  if (
    !firstSegment ||
    (!skipSegmentAllowlist &&
      !isLocalMode() &&
      !RUNTIME_PROXIED_FIRST_SEGMENTS.has(firstSegment))
  ) {
    return null;
  }

  // Splice the platform's base out and the user's gateway in. Path and
  // query are preserved verbatim — the gateway exposes the same
  // `/v1/assistants/{id}/...` routes the platform's RuntimeProxyView
  // would otherwise forward to.
  const rewrittenUrl = new URL(ingressUrl);
  const prefix = rewrittenUrl.pathname.replace(/\/$/, "");
  rewrittenUrl.pathname = prefix + url.pathname;
  rewrittenUrl.search = url.search;

  // Build a fresh header set. Drop platform-only headers; keep client +
  // interface ids so the user's gateway can echo them back for self-echo
  // suppression once the SSE wiring lands on the same path.
  const headers = new Headers(request.headers);
  headers.delete("X-CSRFToken");
  headers.delete("Vellum-Organization-Id");

  const token = getSelfHostedActorToken();
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  } else {
    // Belt-and-braces — never forward a stale Authorization header that
    // happened to be set by a caller. Without a token we want the
    // gateway to respond 401 so the chat surface lands on its error
    // state rather than spinning indefinitely.
    headers.delete("Authorization");
  }

  // In local mode the gateway proxy runs over plain HTTP, and Chrome
  // refuses to send a streaming (duplex: "half") body without TLS
  // (ERR_ALPN_NEGOTIATION_FAILED). Buffer the body as an ArrayBuffer so
  // the Request carries a finite-length payload. Platform self-hosted
  // uses TLS, so keep the streaming body to avoid buffering large uploads.
  const body = isLocalMode()
    ? (request.body ? await request.arrayBuffer() : null)
    : request.body;

  const init: RequestInit = {
    method: request.method,
    headers,
    body,
    // Bearer auth replaces cookie auth — don't leak the platform's
    // session cookie to the user's gateway.
    credentials: "omit",
    redirect: request.redirect,
    signal: request.signal,
  };
  if (!isLocalMode() && request.body) {
    (init as RequestInit & { duplex: "half" }).duplex = "half";
  }
  return new Request(rewrittenUrl.toString(), init);
}

/**
 * Builds a request interceptor for a HeyAPI client.
 *
 * @param skipSegmentAllowlist — `true` for the daemon client (every
 *   daemon SDK endpoint is a daemon route by definition, so all
 *   assistant sub-resource paths are forwarded to the self-hosted
 *   gateway unconditionally). `false` for the platform and auth
 *   clients (only allowlisted segments are forwarded; platform-owned
 *   routes like maintenance-mode, system-events, etc. fall through
 *   to Django).
 */
function createInterceptor({ skipSegmentAllowlist = false } = {}) {
  return async (request: Request): Promise<Request> => {
    const newRequest = new Request(request);

    // Per-tab client identity — sent on *every* request (GET included)
    // so SSE-via-fetch readers and short-lived mutations carry the same
    // id. Stamped first so it rides on both the platform and
    // self-hosted paths.
    for (const [name, value] of Object.entries(
      getClientRegistrationHeaders(),
    )) {
      newRequest.headers.set(name, value);
    }

    // Self-hosted assistant + runtime-proxied path → talk to the user's
    // gateway directly instead of stamping the platform's session/CSRF
    // headers.
    const selfHosted = await rewriteForSelfHostedIngress(newRequest, {
      skipSegmentAllowlist,
    });
    if (selfHosted) {
      return selfHosted;
    }

    // Platform path — Django session auth.
    if (isElectron() && MUTATING_METHODS.has(request.method)) {
      newRequest.headers.set(
        ELECTRON_RENDERER_ORIGIN_HEADER,
        getRendererTupleOrigin(),
      );
    }

    const organizationId = getActiveOrganizationIdForRequests();
    if (organizationId) {
      newRequest.headers.set("Vellum-Organization-Id", organizationId);
    }

    // Electron app provides a session token header. This is no-ops on web.
    const sessionToken = getElectronSessionToken();
    if (sessionToken) {
      newRequest.headers.set("X-Session-Token", sessionToken);
    }

    if (MUTATING_METHODS.has(request.method)) {
      await ensureCsrfCookie();
      const csrfToken = getCsrfToken();
      if (csrfToken) {
        newRequest.headers.set("X-CSRFToken", csrfToken);
      }
    }

    return newRequest;
  };
}

/** Platform + auth clients: uses the segment allowlist. */
export const requestInterceptor = createInterceptor();

/** Daemon client: bypasses the segment allowlist. */
export const daemonRequestInterceptor = createInterceptor({
  skipSegmentAllowlist: true,
});

daemonClient.interceptors.request.use(daemonRequestInterceptor);

for (const apiClient of [authClient, platformClient]) {
  apiClient.interceptors.request.use(requestInterceptor);
}

function arePlatformFeaturesEnabled(): boolean {
  return (
    (useAssistantFeatureFlagStore.getState() as Record<string, unknown>)
      .platformFeaturesInLocalMode !== false
  );
}

/**
 * In local mode with platform features disabled, abort platform client
 * requests that still target the platform — but let through requests
 * already rewritten to the self-hosted gateway by the preceding
 * {@link requestInterceptor}. Without this check, daemon endpoints
 * (skills, memories, etc.) that route through the platform client would
 * be silently killed even though they target the local daemon.
 *
 * Exported for direct unit testing.
 */
export function platformFeaturesGate(request: Request): Request {
  if (!isLocalMode()) return request;
  if (arePlatformFeaturesEnabled()) return request;

  const ingressUrl = getSelfHostedIngressUrl();
  if (ingressUrl) {
    const requestOrigin = new URL(request.url).origin;
    const gatewayOrigin = new URL(ingressUrl).origin;
    if (requestOrigin === gatewayOrigin) return request;
  }

  console.debug(
    "platform-features-in-local-mode is disabled — no-op platform request:",
    new URL(request.url).pathname,
  );
  const aborted = new AbortController();
  aborted.abort(
    new DOMException("Platform features disabled in local mode", "AbortError"),
  );
  return new Request(request.url, { signal: aborted.signal });
}

platformClient.interceptors.request.use(platformFeaturesGate);
