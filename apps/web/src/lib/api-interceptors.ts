/**
 * Request/response interceptors for the generated HeyAPI clients.
 *
 * For platform-bound requests, attaches:
 *   - `Vellum-Organization-Id` — selects the active org server-side.
 *   - `X-CSRFToken` (mutations only) — required by Django's
 *     SessionAuthentication.
 *   - `X-Vellum-Client-Id` + `X-Vellum-Interface-Id` — identify the
 *     originating tab/interface to the daemon. Required by ATL-703 self-echo
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
import { client as authClient } from "@/generated/auth/client.gen";
import { client as daemonClient } from "@/generated/daemon/client.gen";
import { client as platformClient } from "@/generated/api/client.gen";
import { ensureCsrfCookie, getCsrfToken } from "@/lib/auth/csrf";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import {
  getSelfHostedActorToken,
  getSelfHostedIngressUrl,
} from "@/lib/self-hosted/connection";
import { isLocalMode } from "@/lib/local-mode";
import { getClientRegistrationHeaders } from "@/lib/telemetry/client-identity";
import { getActiveOrganizationIdForRequests } from "@/stores/organization-store";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Narrow allowlist of `/v1/assistants/{id}/<segment>/...` first segments
 * that the platform proxies to the assistant's pod (and that we therefore
 * have to redirect to the user's gateway when self-hosted).
 *
 * Kept intentionally narrow rather than mirroring Django's whole proxy
 * routing table: the platform owns the source of truth
 * (`config/api_router.py` registers `RuntimeProxyWildcardView` AFTER all
 * the ViewSet actions + `assistant/urls.py` entries, so anything not
 * already claimed there falls through to the wildcard), and copying that
 * deny-list into the SPA risks regressing platform-owned routes like
 * `maintenance-mode/`, `system-events/`, `terminal/`, `doctor/` when a
 * new one is added on the backend.
 *
 * Today's only consumer is the chat-page bootstrap — `conversations/`
 * has to land on the gateway so the chat surface can fail-and-render the
 * error state. Add segments here as additional self-hosted flows light up.
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
 * the path isn't an allowlisted runtime segment — callers should fall
 * through to the default platform-dressing path in that case.
 *
 * Exported for direct unit testing — production code paths invoke this
 * via {@link requestInterceptor}.
 */
export async function rewriteForSelfHostedIngress(
  request: Request,
): Promise<Request | null> {
  const ingressUrl = getSelfHostedIngressUrl();
  if (!ingressUrl) return null;

  const url = new URL(request.url);

  const match = ASSISTANT_PATH_RE.exec(url.pathname);
  if (!match) return null;
  const firstSegment = match[1];
  if (
    !firstSegment ||
    (!isLocalMode() && !RUNTIME_PROXIED_FIRST_SEGMENTS.has(firstSegment))
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
 * Exported for direct unit testing — production code paths invoke this
 * via the registrations at the bottom of the module. Keeping the function
 * named + exported lets tests assert the per-header contract without
 * reaching into the HeyAPI client's private interceptor list.
 */
export async function requestInterceptor(request: Request): Promise<Request> {
  const newRequest = new Request(request);

  // Per-tab client identity — sent on *every* request (GET included) so
  // SSE-via-fetch readers and short-lived mutations carry the same id.
  // Stamped first so it rides on both the platform and self-hosted paths.
  for (const [name, value] of Object.entries(getClientRegistrationHeaders())) {
    newRequest.headers.set(name, value);
  }

  // Self-hosted assistant + runtime-proxied path → talk to the user's
  // gateway directly instead of stamping the platform's session/CSRF
  // headers and hitting the runtime proxy view that filters us out.
  const selfHosted = await rewriteForSelfHostedIngress(newRequest);
  if (selfHosted) {
    return selfHosted;
  }

  // Platform path — Django session auth.
  const organizationId = getActiveOrganizationIdForRequests();
  if (organizationId) {
    newRequest.headers.set("Vellum-Organization-Id", organizationId);
  }

  if (MUTATING_METHODS.has(request.method)) {
    await ensureCsrfCookie();
    const csrfToken = getCsrfToken();
    if (csrfToken) {
      newRequest.headers.set("X-CSRFToken", csrfToken);
    }
  }

  return newRequest;
}

for (const apiClient of [authClient, daemonClient, platformClient]) {
  apiClient.interceptors.request.use(requestInterceptor);
}

function arePlatformFeaturesEnabled(): boolean {
  return (
    (useAssistantFeatureFlagStore.getState() as Record<string, unknown>)
      .platformFeaturesInLocalMode !== false
  );
}

platformClient.interceptors.request.use((request: Request) => {
  if (!isLocalMode()) return request;
  if (arePlatformFeaturesEnabled()) return request;

  console.debug(
    "platform-features-in-local-mode is disabled — no-op platform request:",
    new URL(request.url).pathname,
  );
  const aborted = new AbortController();
  aborted.abort(
    new DOMException("Platform features disabled in local mode", "AbortError"),
  );
  return new Request(request.url, { signal: aborted.signal });
});
