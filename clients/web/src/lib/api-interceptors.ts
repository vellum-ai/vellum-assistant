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
import {
  UNREACHABLE_STATUS_CODES,
  notifyAssistantUnreachable,
} from "@/assistant/unreachable-bus";
import { client as platformClient } from "@/generated/api/client.gen";
import { client as authClient } from "@/generated/auth/client.gen";
import { client as daemonClient } from "@/generated/daemon/client.gen";
import { client as gatewayClient } from "@/generated/gateway/client.gen";
import { ensureCsrfCookie, getCsrfToken } from "@/lib/auth/csrf";
import { clearGatewayToken } from "@/lib/auth/gateway-session";
import { ApiError, extractErrorMessage } from "@/utils/api-errors";
import {
  getLocalGatewayUrl,
  getPlatformRuntimeUrl,
  isLocalMode,
  isPlatformDisabled,
  isRemoteGatewayMode,
} from "@/lib/local-mode";
import {
  getSelfHostedActorToken,
  getSelfHostedIngressUrl,
} from "@/lib/self-hosted/connection";
import { getClientRegistrationHeaders } from "@/lib/telemetry/client-identity";
import { getDeviceId } from "@/runtime/device-id";
import { isElectron } from "@/runtime/is-electron";
import { getElectronSessionToken } from "@/runtime/session-token";
import { getActiveOrganizationIdForRequests } from "@/stores/organization-store";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const ELECTRON_RENDERER_ORIGIN_HEADER = "X-Vellum-Electron-Renderer-Origin";
const NGROK_SKIP_BROWSER_WARNING_HEADER = "ngrok-skip-browser-warning";

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
const PLATFORM_OWNED_FIRST_SEGMENTS = new Set<string>(["oauth"]);

const ASSISTANT_PATH_RE =
  /^\/v1\/assistants\/([^/]+)\/([^/?#]+)(?:\/.*)?$/;

const platformAssistantIdCache = new Map<string, Promise<string | null>>();

type PlatformStatusBody = {
  assistantId?: unknown;
  assistant_id?: unknown;
  platformAssistantId?: unknown;
  platform_assistant_id?: unknown;
};

type EnsureRegistrationBody = {
  assistant?: {
    id?: unknown;
  };
};

/** @internal Exposed for test teardown only. */
export function resetPlatformAssistantIdCacheForTesting(): void {
  platformAssistantIdCache.clear();
}

async function resolvePlatformAssistantIdForRuntime(
  runtimeAssistantId: string,
  ingressUrl: string | null,
): Promise<string | null> {
  const token = getSelfHostedActorToken();
  const lookupIngressUrls = getPlatformStatusLookupIngressUrls(ingressUrl);
  const cacheKey = `${lookupIngressUrls.join("|")}::${runtimeAssistantId}`;
  const cached = platformAssistantIdCache.get(cacheKey);
  if (cached) return cached;

  const promise = (async () => {
    if (token) {
      for (const lookupIngressUrl of lookupIngressUrls) {
        const assistantId = await fetchPlatformStatusAssistantId(
          lookupIngressUrl,
          runtimeAssistantId,
          token,
        );
        if (assistantId && assistantId !== runtimeAssistantId) return assistantId;
      }
    }
    return fetchPlatformRegistrationAssistantId(runtimeAssistantId);
  })();

  platformAssistantIdCache.set(cacheKey, promise);
  const result = await promise;
  if (!result) {
    platformAssistantIdCache.delete(cacheKey);
  }
  return result;
}

function getPlatformStatusLookupIngressUrls(ingressUrl: string | null): string[] {
  const candidates: string[] = [];
  if (isLocalMode() && !isRemoteGatewayMode()) {
    const localGatewayUrl = getLocalGatewayUrl();
    if (localGatewayUrl) {
      candidates.push(
        new URL(localGatewayUrl, ingressUrl ?? window.location.origin).toString(),
      );
    }
  }
  if (ingressUrl) {
    candidates.push(ingressUrl);
  }
  return [...new Set(candidates)];
}

async function fetchPlatformStatusAssistantId(
  ingressUrl: string,
  runtimeAssistantId: string,
  token: string,
): Promise<string | null> {
  const statusUrl = new URL(ingressUrl);
  const prefix = statusUrl.pathname.replace(/\/$/, "");
  const encodedAssistantId = encodeURIComponent(runtimeAssistantId);
  statusUrl.pathname =
    `${prefix}/v1/assistants/${encodedAssistantId}/platform/status`;

  const headers = new Headers({
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
  });
  if (isRemoteGatewayMode()) {
    headers.set(NGROK_SKIP_BROWSER_WARNING_HEADER, "true");
  }

  const response = await fetch(statusUrl.toString(), {
    headers,
    credentials: "omit",
  }).catch(() => null);
  if (!response?.ok) return null;

  const body = (await response.json().catch(() => null)) as
    | PlatformStatusBody
    | null;
  return firstNonEmptyString(
    body?.assistantId,
    body?.assistant_id,
    body?.platformAssistantId,
    body?.platform_assistant_id,
  );
}

async function fetchPlatformRegistrationAssistantId(
  runtimeAssistantId: string,
): Promise<string | null> {
  if (!isLocalMode() || isRemoteGatewayMode()) return null;

  const deviceId = getDeviceId();
  const organizationId = getActiveOrganizationIdForRequests();
  if (!deviceId || !organizationId) return null;

  const url = new URL(
    "/v1/assistants/self-hosted-local/ensure-registration/",
    getPlatformRuntimeUrl(),
  );
  const headers = new Headers({
    Accept: "application/json",
    "Content-Type": "application/json",
    "Vellum-Organization-Id": organizationId,
  });

  const sessionToken = getElectronSessionToken();
  if (sessionToken) {
    headers.set("X-Session-Token", sessionToken);
  }
  if (isElectron()) {
    headers.set(ELECTRON_RENDERER_ORIGIN_HEADER, getRendererTupleOrigin());
  } else {
    await ensureCsrfCookie();
    const csrfToken = getCsrfToken();
    if (csrfToken) {
      headers.set("X-CSRFToken", csrfToken);
    }
  }

  const response = await fetch(url.toString(), {
    method: "POST",
    headers,
    credentials: isElectron() ? "omit" : "same-origin",
    body: JSON.stringify({
      client_installation_id: deviceId,
      runtime_assistant_id: runtimeAssistantId,
      client_platform: "macos",
    }),
  }).catch(() => null);
  if (!response?.ok) return null;

  const body = (await response.json().catch(() => null)) as
    | EnsureRegistrationBody
    | null;
  return firstNonEmptyString(body?.assistant?.id);
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

async function rewritePlatformOwnedAssistantRequest(
  request: Request,
): Promise<Request | null> {
  const ingressUrl = getSelfHostedIngressUrl();

  const url = new URL(request.url);
  const match = ASSISTANT_PATH_RE.exec(url.pathname);
  if (!match) return null;

  const [, runtimeAssistantId, firstSegment] = match;
  if (
    !runtimeAssistantId ||
    !firstSegment ||
    !PLATFORM_OWNED_FIRST_SEGMENTS.has(firstSegment)
  ) {
    return null;
  }

  const platformAssistantId = await resolvePlatformAssistantIdForRuntime(
    decodeURIComponent(runtimeAssistantId),
    ingressUrl,
  );
  if (!platformAssistantId || platformAssistantId === runtimeAssistantId) {
    return null;
  }

  url.pathname = url.pathname.replace(
    /^\/v1\/assistants\/[^/]+\//,
    `/v1/assistants/${encodeURIComponent(platformAssistantId)}/`,
  );
  return new Request(url.toString(), request);
}

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
  const firstSegment = match[2];
  if (
    firstSegment &&
    !skipSegmentAllowlist &&
    PLATFORM_OWNED_FIRST_SEGMENTS.has(firstSegment)
  ) {
    return null;
  }
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
  if (isRemoteGatewayMode()) {
    // Ngrok free tunnels return an HTML interstitial to browser-shaped API
    // requests unless this bypass header is present.
    headers.set(NGROK_SKIP_BROWSER_WARNING_HEADER, "true");
  }

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
 * Remote-gateway mode serves the app and the gateway from the same nginx edge.
 * Some platform-generated clients still call same-origin flat `/v1/...` routes
 * (for example client feature flags), so they do not pass through the
 * `/v1/assistants/{id}/...` self-hosted rewrite above. Treat those as gateway
 * requests too: attach the paired browser token and strip platform-only auth.
 */
export function authorizeRemoteGatewayRequest(
  request: Request,
): Request | null {
  if (!isRemoteGatewayMode()) return null;

  const ingressUrl = getSelfHostedIngressUrl();
  if (!ingressUrl) return null;

  const url = new URL(request.url);
  const ingress = new URL(ingressUrl);
  const prefix = ingress.pathname.replace(/\/$/, "");
  if (url.origin !== ingress.origin) return null;
  if (!url.pathname.startsWith(`${prefix}/v1/`)) return null;

  const assistantMatch = ASSISTANT_PATH_RE.exec(
    url.pathname.slice(prefix.length),
  );
  if (
    assistantMatch?.[2] &&
    PLATFORM_OWNED_FIRST_SEGMENTS.has(assistantMatch[2])
  ) {
    return null;
  }

  const headers = new Headers(request.headers);
  headers.delete("X-CSRFToken");
  headers.delete("Vellum-Organization-Id");
  headers.set(NGROK_SKIP_BROWSER_WARNING_HEADER, "true");

  const token = getSelfHostedActorToken();
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  } else {
    headers.delete("Authorization");
  }

  return new Request(request, {
    headers,
    credentials: "omit",
  });
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
    let newRequest = new Request(request);

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

    const platformOwned = await rewritePlatformOwnedAssistantRequest(newRequest);
    if (platformOwned) {
      newRequest = platformOwned;
    }

    const remoteGateway = authorizeRemoteGatewayRequest(newRequest);
    if (remoteGateway) {
      return remoteGateway;
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

    const deviceId = getDeviceId();
    if (deviceId) {
      newRequest.headers.set("Vellum-Device-Id", deviceId);
    }

    // Electron app provides a session token header. This is no-ops on web.
    const sessionToken = getElectronSessionToken();
    if (sessionToken) {
      newRequest.headers.set("X-Session-Token", sessionToken);
    }

    // Clients authenticating via session cookie need to pass CSRF checks.
    // Electron authenticates via a session token header.
    if (!isElectron() && MUTATING_METHODS.has(request.method)) {
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

/**
 * Daemon-only response interceptor — fires the unreachable bus on
 * gateway-class errors. No URL filtering needed because every daemon
 * SDK request targets the assistant runtime by definition. Not
 * installed on platform/auth clients (a 502 from Django is a
 * different failure domain).
 */
export function daemonUnreachableInterceptor(response: Response): Response {
  if (UNREACHABLE_STATUS_CODES.has(response.status)) {
    notifyAssistantUnreachable();
  }
  return response;
}

/**
 * Daemon response interceptor for local gateway 401 recovery.
 *
 * When the local gateway rejects a request with 401 (stale or invalid
 * token), clears the cached gateway tokens from localStorage and
 * reloads the page so the app acquires a fresh token on startup.
 *
 * A sessionStorage cooldown prevents infinite reload loops when the
 * gateway consistently rejects tokens (e.g. after a misconfiguration).
 */
const GW_401_RELOAD_KEY = "vellum:gw:401-reload-at";
const GW_401_COOLDOWN_MS = 600_000;

// In-memory latch: once recovery fires, all subsequent 401s in the same
// page lifecycle are no-ops. Resets naturally on reload.
let gw401RecoveryFired = false;

/** @internal Exposed for test teardown only. */
export function resetGw401RecoveryFlag(): void {
  gw401RecoveryFired = false;
}

export function localGatewayAuthRecoveryInterceptor(response: Response): Response {
  if (response.status !== 401) {
    return response;
  }
  if (gw401RecoveryFired) {
    return response;
  }
  if (!isLocalMode()) {
    return response;
  }
  const ingressUrl = getSelfHostedIngressUrl();
  if (!ingressUrl) {
    return response;
  }

  // Only recover from 401s that originated from the local gateway.
  // Daemon requests that don't match ASSISTANT_PATH_RE are not rewritten
  // and hit the platform instead — their 401s are handled elsewhere.
  if (!response.url.startsWith(ingressUrl)) {
    return response;
  }

  try {
    const lastReload = sessionStorage.getItem(GW_401_RELOAD_KEY);
    if (lastReload && Date.now() - Number(lastReload) < GW_401_COOLDOWN_MS) {
      return response;
    }
    sessionStorage.setItem(GW_401_RELOAD_KEY, String(Date.now()));
  } catch {
    // sessionStorage unavailable — cannot enforce cooldown, skip reload
    // to avoid infinite reload loops.
    return response;
  }

  gw401RecoveryFired = true;
  clearGatewayToken();
  window.location.reload();

  return response;
}

/**
 * Normalizes HeyAPI's raw thrown errors into {@link ApiError} instances
 * for `throwOnError: true` calls only.
 *
 * HeyAPI's fetch client throws the parsed JSON response body (a plain
 * object) on non-OK responses. Downstream consumers like
 * {@link shouldRetryDaemonError} match on `error instanceof ApiError`
 * to decide whether to retry transient HTTP errors (503, 502, 401).
 * Without this interceptor, those checks always fail and retries never
 * fire.
 *
 * Only applies when the caller set `throwOnError: true` (generated
 * query factories). Callers using `throwOnError: false` inspect the
 * raw error body for machine-readable fields (e.g. `error: "secret_blocked"`
 * from `postChatMessage`) — wrapping those into `ApiError` would discard
 * the structured payload.
 *
 * Reference: https://heyapi.dev/openapi-ts/clients/fetch#interceptors
 */
export function daemonErrorInterceptor(
  error: unknown,
  response: Response | undefined,
  _request: Request | undefined,
  options: { throwOnError?: boolean },
): unknown {
  if (!options.throwOnError) return error;
  if (error instanceof ApiError) return error;
  if (!response || response.ok) return error;
  return new ApiError(
    response.status,
    extractErrorMessage(error, response, `HTTP ${response.status}`),
  );
}

daemonClient.interceptors.request.use(daemonRequestInterceptor);
daemonClient.interceptors.response.use(daemonUnreachableInterceptor);
daemonClient.interceptors.response.use(localGatewayAuthRecoveryInterceptor);
daemonClient.interceptors.error.use(daemonErrorInterceptor);

// Gateway client uses the same routing as daemon — all gateway endpoints
// are proxied through the same self-hosted ingress / platform gateway path.
gatewayClient.interceptors.request.use(daemonRequestInterceptor);
gatewayClient.interceptors.response.use(daemonUnreachableInterceptor);
gatewayClient.interceptors.error.use(daemonErrorInterceptor);

// Force JSON body parsing for all three generated clients. The default
// `parseAs: 'auto'` infers the parsing strategy from the Content-Type
// response header. When the header is absent (observed on iOS WKWebView
// under concurrent fetch load), the client falls back to `'stream'`
// mode and returns `response.body` (a ReadableStream or null) as
// `data` — producing the "body=null" errors reported in LUM-2371.
//
// Every endpoint in these OpenAPI specs returns JSON; non-JSON call
// sites (blob downloads) explicitly override `parseAs` per-request.
//
// Reference: https://heyapi.dev/openapi-ts/clients/fetch#parser
for (const apiClient of [daemonClient, gatewayClient, platformClient, authClient]) {
  apiClient.setConfig({ parseAs: "json" });
}

for (const apiClient of [authClient, platformClient]) {
  apiClient.interceptors.request.use(requestInterceptor);
}

function arePlatformFeaturesEnabled(): boolean {
  return !isPlatformDisabled();
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
    "VELLUM_DISABLE_PLATFORM is set — no-op platform request:",
    new URL(request.url).pathname,
  );
  const aborted = new AbortController();
  aborted.abort(
    new DOMException("Platform features disabled in local mode", "AbortError"),
  );
  return new Request(request.url, { signal: aborted.signal });
}

platformClient.interceptors.request.use(platformFeaturesGate);
