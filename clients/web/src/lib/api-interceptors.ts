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
 * (`main.tsx`) so interceptors are installed before any API call fires. The
 * same import installs the post-resume request counter these interceptors feed,
 * which needs to be subscribed to `app.resume` before React mounts.
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
import { ApiError, toApiError } from "@/utils/api-errors";
import {
  isLocalClient,
  isPlatformDisabled,
  isRemoteGatewayMode,
} from "@/lib/local-mode";
import {
  getSelfHostedActorToken,
  getSelfHostedIngressUrl,
} from "@/lib/self-hosted/connection";
import { getClientRegistrationHeaders } from "@/lib/telemetry/client-identity";
import {
  installResumeRequestCounter,
  isResumeWindowOpen,
  noteDaemonApiRequest,
} from "@/lib/telemetry/resume-request-counter";
import { getDeviceId } from "@/runtime/device-id";
import { isElectron } from "@/runtime/is-electron";
import { getElectronSessionToken } from "@/runtime/session-token";
import { getActiveOrganizationIdForRequests } from "@/stores/organization-store";
import { hardNavigate } from "@/lib/auth/hard-navigate";
import { useAuthStore, whenPlatformSessionSettled } from "@/stores/auth-store";
import {
  hasLivePlatformSession,
  isAuthenticated,
  isSettledSessionRejection,
} from "@/stores/session-status";
import { routes } from "@/utils/routes";

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
const RUNTIME_PROXIED_FIRST_SEGMENTS = new Set<string>([
  "conversations",
  // Live SSE event stream — `subscribeEvents` opens it through the
  // platform client, so it must be forwarded to the gateway in local /
  // self-hosted mode like any other runtime route.
  "events",
  // User-defined route handlers (`/v1/x/*`). Sandboxed apps reach their
  // backend handlers through the platform client (the sandbox fetch
  // proxy in `useSandboxFetchProxy`, gated to `/v1/x/` paths), so these
  // must be forwarded to the gateway in local / self-hosted mode rather
  // than falling through to the platform proxy.
  "x",
  // Daemon-owned app-serving routes (`/v1/apps/*`: bundled asset media and
  // compiled dist files). The sandbox asset proxy in `useSandboxFetchProxy`
  // fetches `/v1/assistants/{id}/apps/{appId}/asset/...` through the platform
  // client, so it must be forwarded to the gateway in local / self-hosted
  // mode rather than falling through to the platform proxy.
  "apps",
  // Daemon-owned config reached through the platform client via raw
  // `client.*` calls (the background `TimezoneSync` PATCH and the general
  // settings page). Must be forwarded to the gateway in local /
  // self-hosted mode rather than falling through to the dead platform
  // proxy — otherwise the PATCH retries against a nonexistent platform
  // and floods the console with 502s. Removable once those call sites
  // move to the generated daemon SDK (LUM-2716).
  //
  // Every removed entry (contacts, trust-rules, permissions,
  // channel-admission-policy, …) was retired by migrating its call sites
  // to the generated gateway SDK, whose client forwards all
  // assistant-scoped requests without this list — that is the paved road
  // for new endpoints. Deliberately NOT listed: `artifacts` (no
  // gateway/daemon route exists) and `a2a` (platform broker route); those
  // stay on the platform. The contact family (`contacts`,
  // `contact-channels`) is forwarded via {@link FLATTENED_FIRST_SEGMENTS}
  // with the assistant prefix stripped — it does not belong in this
  // allowlist.
  "config",
]);

const ASSISTANT_PATH_RE = /^\/v1\/assistants\/[^/]+\/(([^/?#]+)(?:\/.*)?)$/;

/**
 * First segments whose `/v1/assistants/{id}/` prefix is stripped before
 * forwarding to the ingress. The gateway serves the contact family on
 * flat `/v1/...` control-plane routes only, so the rewrite delivers the
 * same flat shape cloud's Django `RuntimeProxyView` does. Flattened
 * segments are forwarded by every client, allowlist or not.
 */
const FLATTENED_FIRST_SEGMENTS = new Set<string>([
  "contacts",
  "contact-channels",
]);

/**
 * True when a path names daemon/gateway traffic, whichever client issues it.
 * Mirrors the routing decision {@link rewriteForSelfHostedIngress} makes for
 * the platform client, but is deliberately independent of whether an ingress
 * is registered: the same path reaches the daemon through the platform's
 * runtime proxy in cloud mode, so `client_resume.request_count` stays
 * comparable across cloud and self-hosted.
 */
function isDaemonBoundPath(url: string): boolean {
  const match = ASSISTANT_PATH_RE.exec(new URL(url).pathname);
  if (!match) {
    return false;
  }
  const firstSegment = match[2];
  return (
    RUNTIME_PROXIED_FIRST_SEGMENTS.has(firstSegment) ||
    FLATTENED_FIRST_SEGMENTS.has(firstSegment)
  );
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
 *   platform-owned routes (maintenance-mode, system-events, etc.);
 *   {@link FLATTENED_FIRST_SEGMENTS} are forwarded regardless.
 *
 * Exported for direct unit testing — production code paths invoke this
 * via {@link requestInterceptor} / {@link daemonRequestInterceptor}.
 */
export async function rewriteForSelfHostedIngress(
  request: Request,
  { skipSegmentAllowlist = false } = {},
): Promise<Request | null> {
  const ingressUrl = getSelfHostedIngressUrl();
  if (!ingressUrl) {
    return null;
  }

  const url = new URL(request.url);

  const match = ASSISTANT_PATH_RE.exec(url.pathname);
  if (!match) {
    return null;
  }
  const [, subPath, firstSegment] = match;
  if (
    !skipSegmentAllowlist &&
    !RUNTIME_PROXIED_FIRST_SEGMENTS.has(firstSegment) &&
    !FLATTENED_FIRST_SEGMENTS.has(firstSegment)
  ) {
    return null;
  }

  // Splice the platform's base out and the user's gateway in. Contact-family
  // paths are flattened to `/v1/<rest>` — the shape cloud's Django strip
  // delivers to the gateway, which serves them on its flat control-plane
  // routes. Every other segment keeps the scoped path verbatim: the gateway
  // exposes the same `/v1/assistants/{id}/...` routes the platform's
  // RuntimeProxyView would otherwise forward to.
  const rewrittenUrl = new URL(ingressUrl);
  const prefix = rewrittenUrl.pathname.replace(/\/$/, "");
  rewrittenUrl.pathname = FLATTENED_FIRST_SEGMENTS.has(firstSegment)
    ? `${prefix}/v1/${subPath}`
    : prefix + url.pathname;
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
  // (ERR_ALPN_NEGOTIATION_FAILED), so the body must be buffered into a
  // finite-length payload. Buffer to a Blob rather than an ArrayBuffer:
  // an ArrayBuffer body is streamed to the network process through a
  // fixed-capacity (~1-2 MB) data pipe, so a larger upload stalls forever
  // when the local consumer drains the pipe slowly. A Blob is passed by
  // reference (blob handle) and read directly, with no renderer-side data
  // pipe to block on. Platform self-hosted uses TLS, so keep the streaming
  // body there to avoid buffering large uploads.
  const body = isLocalClient()
    ? request.body
      ? await request.blob()
      : null
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
  if (!isLocalClient() && request.body) {
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
  if (!isRemoteGatewayMode()) {
    return null;
  }

  const ingressUrl = getSelfHostedIngressUrl();
  if (!ingressUrl) {
    return null;
  }

  const url = new URL(request.url);
  const ingress = new URL(ingressUrl);
  const prefix = ingress.pathname.replace(/\/$/, "");
  if (url.origin !== ingress.origin) {
    return null;
  }
  if (!url.pathname.startsWith(`${prefix}/v1/`)) {
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
 * @param isDaemonClient `true` for the daemon + gateway clients, where every
 *   endpoint is a daemon route by definition. Two things follow from it: all
 *   assistant sub-resource paths are forwarded to the self-hosted gateway
 *   without consulting {@link RUNTIME_PROXIED_FIRST_SEGMENTS}, and every
 *   request counts toward the post-resume burst. `false` for the platform and
 *   auth clients, where only allowlisted segments are forwarded (platform-owned
 *   routes like maintenance-mode, system-events, etc. fall through to Django)
 *   and only daemon-bound paths ({@link isDaemonBoundPath}) count, the SSE
 *   reopen among them.
 *
 * Counting happens once per request, after the routing decision, and this is
 * the single choke point on each client's chain. On the platform chain it is
 * additionally conditioned on {@link platformFeaturesGateDecision}, the gate
 * registered downstream, so a request that gate aborts is never counted. The
 * auth chain reaches neither test: allauth endpoints live under `/_allauth/`
 * and are never daemon-bound.
 */
function createInterceptor({
  isDaemonClient = false,
  allowRemoteGatewayDirect = false,
} = {}) {
  /**
   * `outgoing` is the request the chain hands downstream; `url` is the original
   * one, which still carries the platform-shaped path a self-hosted rewrite
   * would have replaced.
   */
  function shouldCount(url: string, outgoing: Request): boolean {
    // Cheapest test first: outside a resume window nothing here parses a URL.
    if (!isResumeWindowOpen()) {
      return false;
    }
    if (isDaemonClient) {
      return true;
    }
    return (
      isDaemonBoundPath(url) &&
      platformFeaturesGateDecision(outgoing) === "allow"
    );
  }

  const route = async (request: Request): Promise<Request> => {
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
      skipSegmentAllowlist: isDaemonClient,
    });
    if (selfHosted) {
      return selfHosted;
    }

    if (allowRemoteGatewayDirect) {
      const remoteGateway = authorizeRemoteGatewayRequest(newRequest);
      if (remoteGateway) {
        return remoteGateway;
      }
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

  return async (request: Request): Promise<Request> => {
    const outgoing = await route(request);
    try {
      if (shouldCount(request.url, outgoing)) {
        noteDaemonApiRequest(request.url);
      }
    } catch {
      // Telemetry must never fail a request.
    }
    return outgoing;
  };
}

/** Platform + auth clients: uses the segment allowlist. */
export const requestInterceptor = createInterceptor();

/** Daemon client: bypasses the segment allowlist. */
export const daemonRequestInterceptor = createInterceptor({
  isDaemonClient: true,
  allowRemoteGatewayDirect: true,
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
 * A sessionStorage cooldown spaces the attempts, and a sessionStorage
 * attempt budget stops them. The cooldown alone only paces a gateway that
 * rejects every token (a mismatched signing key, say): the page reloads
 * once per cooldown for as long as the app stays open, which reaches the
 * user as an app that restarts itself every ten minutes and never settles.
 * Past the budget the 401 is handed back untouched, so the normal error
 * path surfaces it and the tray's re-pair action stays available.
 *
 * The budget is spent permanently until the gateway demonstrates that it
 * works: a 2xx from the ingress origin clears it. Elapsed time deliberately
 * does not, because a gateway that is still rejecting every token would
 * otherwise earn a fresh budget out of every quiet spell and reload forever
 * in bursts. A reload that genuinely fixed the session produces that 2xx on
 * its next request, so a transient rejection is not charged for recovering.
 *
 * Both keys live in sessionStorage, so quitting and reopening the app also
 * grants a fresh budget.
 *
 * Installed on `daemonClient` only. `gatewayClient` does not carry this
 * interceptor, so 401s raised through the generated gateway SDK are not
 * recovered here; see the registrations at the bottom of this file.
 */
const GW_401_RELOAD_KEY = "vellum:gw:401-reload-at";
const GW_401_ATTEMPTS_KEY = "vellum:gw:401-reload-attempts";
const GW_401_COOLDOWN_MS = 600_000;
const GW_401_MAX_RELOADS = 3;

// In-memory latch: once recovery fires, all subsequent 401s in the same
// page lifecycle are no-ops. Resets naturally on reload.
let gw401RecoveryFired = false;

/** @internal Exposed for test teardown only. */
export function resetGw401RecoveryFlag(): void {
  gw401RecoveryFired = false;
}

export function localGatewayAuthRecoveryInterceptor(
  response: Response,
): Response {
  if (!isLocalClient()) {
    return response;
  }
  const ingressUrl = getSelfHostedIngressUrl();
  if (!ingressUrl) {
    return response;
  }

  // Only act on responses that originated from the local gateway. Daemon
  // requests that don't match ASSISTANT_PATH_RE are not rewritten and hit
  // the platform instead; their 401s are handled elsewhere.
  if (!response.url.startsWith(ingressUrl)) {
    return response;
  }

  // The gateway answering a request is the only evidence that the token it
  // was rejecting has been replaced by a working one, so it is the only
  // thing that restores the budget. `/readyz` probes use a bare `fetch`
  // rather than this client, so an unauthenticated liveness check cannot
  // stand in for a real one.
  if (response.ok) {
    try {
      sessionStorage.removeItem(GW_401_ATTEMPTS_KEY);
      sessionStorage.removeItem(GW_401_RELOAD_KEY);
    } catch {
      // sessionStorage unavailable; the budget check below fails closed.
    }
    return response;
  }

  if (response.status !== 401) {
    return response;
  }
  if (gw401RecoveryFired) {
    return response;
  }

  try {
    const stored = Number(sessionStorage.getItem(GW_401_ATTEMPTS_KEY) ?? "0");
    const attempts = Number.isFinite(stored) ? stored : 0;

    // A spent budget means reloading has not made this gateway work, and
    // nothing since has shown that it does; let the 401 through to the
    // error path.
    if (attempts >= GW_401_MAX_RELOADS) {
      return response;
    }
    const lastReload = sessionStorage.getItem(GW_401_RELOAD_KEY);
    if (lastReload && Date.now() - Number(lastReload) < GW_401_COOLDOWN_MS) {
      return response;
    }
    sessionStorage.setItem(GW_401_RELOAD_KEY, String(Date.now()));
    sessionStorage.setItem(GW_401_ATTEMPTS_KEY, String(attempts + 1));
  } catch {
    // sessionStorage unavailable: cannot enforce cooldown or budget, skip
    // reload to avoid infinite reload loops.
    return response;
  }

  gw401RecoveryFired = true;
  clearGatewayToken();
  window.location.reload();

  return response;
}

// In-memory latch so a burst of concurrent session rejections triggers only
// one recovery. Reset in the recovery's `finally` so a genuine expiry after a
// permission-403 that left the session live is still caught later.
let platformAuthRecoveryFired = false;

/**
 * Caps the login redirects below. The redirect is a full page load, so the
 * in-memory latch cannot count round trips and a destination that bounces back
 * and rejects again would drive them without bound. Only a confirmed platform
 * session restores the budget; sessionStorage means a relaunch grants a fresh
 * one.
 */
const PLATFORM_AUTH_REDIRECT_KEY = "vellum:platform:auth-redirect-attempts";
const PLATFORM_AUTH_MAX_REDIRECTS = 3;

/** @internal Exposed for test teardown only. */
export function resetPlatformAuthRecoveryFlag(): void {
  platformAuthRecoveryFired = false;
  platformRecoveryOutstanding = false;
}

/**
 * Spend one redirect. False when the budget is exhausted, or when
 * sessionStorage is unavailable so an uncountable environment fails closed.
 */
function claimPlatformAuthRedirect(): boolean {
  try {
    const stored = Number(
      sessionStorage.getItem(PLATFORM_AUTH_REDIRECT_KEY) ?? "0",
    );
    const attempts = Number.isFinite(stored) ? stored : 0;
    if (attempts >= PLATFORM_AUTH_MAX_REDIRECTS) {
      return false;
    }
    sessionStorage.setItem(PLATFORM_AUTH_REDIRECT_KEY, String(attempts + 1));
    return true;
  } catch {
    return false;
  }
}

/**
 * Restore the budget. Gated on a confirmed platform session by the caller: the
 * platform serves some routes (client feature flags) to anonymous visitors, so
 * a 2xx alone does not mean the session works.
 */
function clearPlatformAuthRedirectBudget(): void {
  try {
    sessionStorage.removeItem(PLATFORM_AUTH_REDIRECT_KEY);
  } catch {
    // sessionStorage unavailable; the claim above already fails closed.
  }
}

/**
 * Cooldown + attempt budget for the recovery re-probe, mirroring the
 * local-gateway 401 pattern above. The cooldown spaces cycles and the budget
 * stops them; with the refund below, the cap binds when re-probes repeatedly
 * fail to settle (refreshSession throwing on a flaky network while the API
 * keeps rejecting). Quitting the app grants a fresh budget (sessionStorage).
 */
const PLATFORM_RECOVERY_AT_KEY = "vellum:platform:recovery-attempt-at";
const PLATFORM_RECOVERY_ATTEMPTS_KEY = "vellum:platform:recovery-attempts";
const PLATFORM_RECOVERY_PATH_KEY = "vellum:platform:recovery-path";
const PLATFORM_RECOVERY_COOLDOWN_MS = 600_000;
const PLATFORM_RECOVERY_MAX_ATTEMPTS = 3;

// Skips the ok-branch heal check until a claim is made. Seeded from storage:
// a claim from this page's earlier life may still be awaiting its heal.
let platformRecoveryOutstanding = (() => {
  try {
    return sessionStorage.getItem(PLATFORM_RECOVERY_PATH_KEY) !== null;
  } catch {
    return false;
  }
})();

/**
 * Spend one recovery attempt for a rejection on `pathname`; false when the
 * budget or cooldown blocks it, or when sessionStorage is unavailable (fails
 * closed). Only that pathname's later success restores the budget.
 */
function claimPlatformRecoveryAttempt(pathname: string): boolean {
  try {
    const stored = Number(
      sessionStorage.getItem(PLATFORM_RECOVERY_ATTEMPTS_KEY) ?? "0",
    );
    const attempts = Number.isFinite(stored) ? stored : 0;
    if (attempts >= PLATFORM_RECOVERY_MAX_ATTEMPTS) {
      return false;
    }
    const lastAttempt = sessionStorage.getItem(PLATFORM_RECOVERY_AT_KEY);
    if (
      lastAttempt &&
      Date.now() - Number(lastAttempt) < PLATFORM_RECOVERY_COOLDOWN_MS
    ) {
      return false;
    }
    sessionStorage.setItem(PLATFORM_RECOVERY_AT_KEY, String(Date.now()));
    sessionStorage.setItem(
      PLATFORM_RECOVERY_ATTEMPTS_KEY,
      String(attempts + 1),
    );
    sessionStorage.setItem(PLATFORM_RECOVERY_PATH_KEY, pathname);
    platformRecoveryOutstanding = true;
    return true;
  } catch {
    return false;
  }
}

/**
 * Restore the budget only when the last-rejected route succeeds: anonymously
 * served routes (client feature flags) must not re-arm it every poll.
 */
function clearPlatformRecoveryBudgetIfHealed(pathname: string): void {
  try {
    if (sessionStorage.getItem(PLATFORM_RECOVERY_PATH_KEY) !== pathname) {
      return;
    }
    sessionStorage.removeItem(PLATFORM_RECOVERY_AT_KEY);
    sessionStorage.removeItem(PLATFORM_RECOVERY_ATTEMPTS_KEY);
    sessionStorage.removeItem(PLATFORM_RECOVERY_PATH_KEY);
    platformRecoveryOutstanding = false;
  } catch {
    // sessionStorage unavailable; the claim above already fails closed.
  }
}

/**
 * Refund the attempt count but keep the cooldown: a permission 403 on a live
 * session must not eat the budget a later real expiry needs.
 */
function refundPlatformRecoveryAttempt(): void {
  try {
    sessionStorage.removeItem(PLATFORM_RECOVERY_ATTEMPTS_KEY);
    // Drop the remembered pathname too: a leftover key would re-seed the
    // outstanding flag after a reload, letting a heal clear the cooldown
    // this refund deliberately keeps.
    sessionStorage.removeItem(PLATFORM_RECOVERY_PATH_KEY);
  } catch {
    // sessionStorage unavailable; the claim already fails closed.
  }
  platformRecoveryOutstanding = false;
}

/** The response URL's pathname, or null for an unparseable URL. */
function responsePathname(response: Response): string | null {
  try {
    return new URL(response.url).pathname;
  } catch {
    return null;
  }
}

async function recoverFromPlatformSessionRejection(): Promise<void> {
  try {
    // Authoritative re-probe. `refreshSession` calls `getSession()` and only
    // ends the session on a genuine settled rejection, so an ambiguous
    // permission-403 on a still-live session does not log anyone out. In
    // local/gateway mode a platform rejection only drops `platformSession`
    // and keeps `sessionStatus` authenticated, so the redirect below is
    // skipped there.
    await useAuthStore.getState().refreshSession();
    // refreshSession may fire-and-forget the platform probe; hold the latch
    // until it settles so the probe's own rejections cannot re-enter.
    await whenPlatformSessionSettled();
    if (hasLivePlatformSession(useAuthStore.getState().platformSession)) {
      refundPlatformRecoveryAttempt();
    }
    if (
      !isAuthenticated(useAuthStore.getState().sessionStatus) &&
      claimPlatformAuthRedirect()
    ) {
      hardNavigate(
        `${routes.account.login}?returnTo=${encodeURIComponent(
          window.location.pathname + window.location.search,
        )}`,
      );
    }
  } finally {
    platformAuthRecoveryFired = false;
  }
}

/**
 * Response interceptor for a platform session that expires mid-use.
 *
 * A cookie-authenticated request that comes back 401/403/410 while the app
 * still believes it is signed in means the platform session may have ended.
 * Nothing else notices this between boot and app-resume, so the rejection
 * would otherwise surface only as a generic chat error. This re-verifies the
 * session and, when it is truly gone, routes to login via a full reload.
 *
 * No-ops unless the rejection is settled, the app currently reads as
 * authenticated (excludes boot probes and the already-logged-out login flow,
 * and prevents a redirect loop), and the response did not come from the
 * self-hosted / remote-gateway bearer path — those 401s are recovered by
 * {@link localGatewayAuthRecoveryInterceptor}. Recovery claims only for a
 * platform session currently believed live: the boot probe owns unsettled
 * evidence, and a settled-absent session has nothing to recover. Each cycle
 * spends from the cooldown-spaced attempt budget above.
 *
 * A success on the route whose rejection last consumed a recovery attempt
 * restores the recovery budget; a success against a confirmed session also
 * restores the redirect budget.
 */
export function platformAuthRecoveryInterceptor(response: Response): Response {
  const ingressUrl = getSelfHostedIngressUrl();
  const fromSelfHostedGateway =
    !!ingressUrl && response.url.startsWith(ingressUrl);

  if (response.ok) {
    // A working self-hosted gateway says nothing about the platform session.
    if (!fromSelfHostedGateway) {
      if (platformRecoveryOutstanding) {
        const pathname = responsePathname(response);
        if (pathname !== null) {
          clearPlatformRecoveryBudgetIfHealed(pathname);
        }
      }
      if (hasLivePlatformSession(useAuthStore.getState().platformSession)) {
        clearPlatformAuthRedirectBudget();
      }
    }
    return response;
  }

  if (
    !isSettledSessionRejection({ ok: response.ok, status: response.status })
  ) {
    return response;
  }
  if (platformAuthRecoveryFired) {
    return response;
  }
  const { sessionStatus, platformSession } = useAuthStore.getState();
  if (!isAuthenticated(sessionStatus)) {
    return response;
  }
  if (fromSelfHostedGateway) {
    return response;
  }
  if (!hasLivePlatformSession(platformSession)) {
    return response;
  }
  const rejectedPathname = responsePathname(response);
  if (
    rejectedPathname === null ||
    !claimPlatformRecoveryAttempt(rejectedPathname)
  ) {
    return response;
  }

  platformAuthRecoveryFired = true;
  void recoverFromPlatformSessionRejection();

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
  if (!options.throwOnError) {
    return error;
  }
  if (error instanceof ApiError) {
    return error;
  }
  if (!response || response.ok) {
    return error;
  }
  return toApiError(error, response);
}

// Register the post-resume counting window here, alongside the interceptors
// that feed it. `main.tsx` imports this module for its side effects before
// React renders, so the counter's `app.resume` handler lands ahead of every
// subscriber the React tree adds and the requests they fire synchronously on
// resume are counted. See the function's docstring for why a React effect
// cannot give that guarantee.
installResumeRequestCounter();

daemonClient.interceptors.request.use(daemonRequestInterceptor);
daemonClient.interceptors.response.use(daemonUnreachableInterceptor);
daemonClient.interceptors.response.use(localGatewayAuthRecoveryInterceptor);
daemonClient.interceptors.response.use(platformAuthRecoveryInterceptor);
daemonClient.interceptors.error.use(daemonErrorInterceptor);

// Gateway client uses the same routing as daemon — all gateway endpoints
// are proxied through the same self-hosted ingress / platform gateway path.
//
// It deliberately does NOT carry `localGatewayAuthRecoveryInterceptor`: a
// 401 raised through the generated gateway SDK is surfaced to the caller
// rather than triggering a reload. Adding it here would widen the set of
// responses that can restart the app, which is the opposite of what the
// recovery budget is for, so it is tracked separately.
gatewayClient.interceptors.request.use(daemonRequestInterceptor);
gatewayClient.interceptors.response.use(daemonUnreachableInterceptor);
gatewayClient.interceptors.response.use(platformAuthRecoveryInterceptor);
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
for (const apiClient of [
  daemonClient,
  gatewayClient,
  platformClient,
  authClient,
]) {
  apiClient.setConfig({ parseAs: "json" });
}

for (const apiClient of [authClient, platformClient]) {
  apiClient.interceptors.request.use(requestInterceptor);
}

// A chat send in cloud mode goes through the daemon client; other platform
// calls go through the platform client. Not installed on `authClient` — the
// allauth session endpoints manage their own 401 semantics, and adding it
// there risks re-entrancy with the `getSession()` inside `refreshSession`.
platformClient.interceptors.response.use(platformAuthRecoveryInterceptor);

function arePlatformFeaturesEnabled(): boolean {
  return !isPlatformDisabled();
}

/**
 * What {@link platformFeaturesGate} does with a request. A deny carries the
 * reason it was denied, so the gate reports it without re-probing the mode the
 * decision already looked at. {@link PLATFORM_GATE_DENIALS} keys off this
 * union, so a third reason cannot be mislabelled as one of the existing two.
 */
type PlatformGateDecision = "allow" | "deny_remote_gateway" | "deny_local";

/**
 * How each denial is reported. Keyed by every deny decision, so a new reason
 * added to {@link PlatformGateDecision} fails to compile until it says what it
 * logs and what it aborts with.
 */
const PLATFORM_GATE_DENIALS: Record<
  Exclude<PlatformGateDecision, "allow">,
  { log: string; abortMessage: string }
> = {
  deny_remote_gateway: {
    log: "remote-gateway mode, no-op platform request:",
    abortMessage: "Platform routes disabled in remote-gateway mode",
  },
  deny_local: {
    log: "VELLUM_DISABLE_PLATFORM is set, no-op platform request:",
    abortMessage: "Platform features disabled in local mode",
  },
};

/**
 * The decision {@link platformFeaturesGate} reaches for this request.
 *
 * Takes the request as the gate sees it: the gate is registered after
 * {@link requestInterceptor}, so a self-hosted rewrite (gateway origin, bearer
 * auth) has already happened by the time it runs.
 */
function platformFeaturesGateDecision(request: Request): PlatformGateDecision {
  if (isRemoteGatewayMode()) {
    const hasBearer =
      request.headers
        .get("Authorization")
        ?.toLowerCase()
        .startsWith("bearer ") ?? false;
    return hasBearer ? "allow" : "deny_remote_gateway";
  }

  if (!isLocalClient()) {
    return "allow";
  }
  if (arePlatformFeaturesEnabled()) {
    return "allow";
  }

  const ingressUrl = getSelfHostedIngressUrl();
  if (!ingressUrl) {
    return "deny_local";
  }
  return new URL(request.url).origin === new URL(ingressUrl).origin
    ? "allow"
    : "deny_local";
}

/**
 * In local mode with platform features disabled, abort platform client
 * requests that still target the platform, but let through requests
 * already rewritten to the self-hosted gateway by the preceding
 * {@link requestInterceptor}. Without this check, daemon endpoints
 * (skills, memories, etc.) that route through the platform client would
 * be silently killed even though they target the local daemon.
 *
 * Exported for direct unit testing.
 */
export function platformFeaturesGate(request: Request): Request {
  const decision = platformFeaturesGateDecision(request);
  if (decision === "allow") {
    return request;
  }

  const denial = PLATFORM_GATE_DENIALS[decision];
  console.debug(denial.log, new URL(request.url).pathname);
  const aborted = new AbortController();
  aborted.abort(new DOMException(denial.abortMessage, "AbortError"));
  return new Request(request.url, { signal: aborted.signal });
}

platformClient.interceptors.request.use(platformFeaturesGate);
