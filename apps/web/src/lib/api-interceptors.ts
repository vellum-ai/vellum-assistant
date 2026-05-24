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
 * For runtime-proxied requests against an assistant registered as
 * self-hosted, {@link rewriteForSelfHostedIngress} takes over instead —
 * the URL's origin is swapped to the assistant's `ingress_url`, the
 * platform-only headers are stripped, cookie credentials are omitted,
 * and an `Authorization: Bearer` is attached when a token is available
 * (it isn't yet — the web pair flow is still being built; see
 * `self-hosted/actor-token.ts`).
 *
 * Import this module for its side effects in the app entrypoint
 * (`main.tsx`) so interceptors are installed before any API call fires.
 *
 * Reference: https://heyapi.dev/openapi-ts/clients/fetch#interceptors
 */
import { client as authClient } from "@/generated/auth/client.gen.js";
import { client as platformClient } from "@/generated/api/client.gen.js";
import { ensureCsrfCookie, getCsrfToken } from "@/lib/auth/csrf.js";
import { getSelfHostedActorToken } from "@/lib/self-hosted/actor-token.js";
import { getSelfHostedRouting } from "@/lib/self-hosted/registry.js";
import { classifyAssistantPath } from "@/lib/self-hosted/request-routing.js";
import { getClientRegistrationHeaders } from "@/lib/telemetry/client-identity.js";
import { getActiveOrganizationIdForRequests } from "@/stores/organization-store.js";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Rewrites a request bound for `/v1/assistants/{id}/...` to the
 * registered self-hosted ingress, swapping platform session/CSRF auth
 * for `Authorization: Bearer <jwt>`.
 *
 * Returns `null` when the path is not a runtime-proxied per-assistant
 * route or when no self-hosted routing is registered for the assistant —
 * callers should fall through to the default platform-dressing path in
 * that case.
 *
 * Exported for direct unit testing — production code paths invoke this
 * via {@link requestInterceptor}.
 */
export async function rewriteForSelfHostedIngress(
  request: Request,
): Promise<Request | null> {
  const url = new URL(request.url);
  const { assistantId, isRuntimeProxied } = classifyAssistantPath(url.pathname);
  if (!assistantId || !isRuntimeProxied) {
    return null;
  }
  const routing = getSelfHostedRouting(assistantId);
  if (!routing) {
    return null;
  }

  // Splice the platform's base out and the user's gateway in. Path and
  // query are preserved verbatim — the gateway exposes the same
  // `/v1/assistants/{id}/...` routes the platform's RuntimeProxyView
  // would otherwise forward to.
  const ingress = new URL(routing.ingressUrl);
  const rewrittenUrl = new URL(ingress.toString());
  rewrittenUrl.pathname = url.pathname;
  rewrittenUrl.search = url.search;

  // Build a fresh header set. Drop platform-only headers; keep client +
  // interface ids so the user's gateway can echo them back for self-echo
  // suppression once the SSE wiring lands on the same path.
  const headers = new Headers(request.headers);
  headers.delete("X-CSRFToken");
  headers.delete("Vellum-Organization-Id");

  const token = await getSelfHostedActorToken(assistantId);
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  } else {
    // Belt-and-braces — never forward a stale Authorization header that
    // happened to be set by a caller. Without a token we want the
    // gateway to respond 401 so the chat surface lands on its error
    // state rather than spinning indefinitely.
    headers.delete("Authorization");
  }

  // `duplex: "half"` is required by the WHATWG fetch spec for any
  // Request constructed with a streaming body, and harmless otherwise.
  // The DOM lib's RequestInit typing hasn't caught up.
  const init: RequestInit = {
    method: request.method,
    headers,
    body: request.body,
    // Bearer auth replaces cookie auth — don't leak the platform's
    // session cookie to the user's gateway.
    credentials: "omit",
    redirect: request.redirect,
    signal: request.signal,
  };
  if (request.body) {
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

  // Self-hosted assistants own their own gateway — route there directly
  // instead of stamping the platform's session/CSRF headers and hitting
  // the runtime proxy view that filters us out anyway.
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

for (const apiClient of [authClient, platformClient]) {
  apiClient.interceptors.request.use(requestInterceptor);
}
