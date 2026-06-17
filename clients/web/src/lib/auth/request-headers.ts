/**
 * **Transitional — do not extend. Slated for deletion.**
 *
 * Shared header builders for raw `fetch()` calls against assistant-scoped
 * routes (`/v1/assistants/{id}/...`).
 *
 * Prefer the generated HeyAPI client (`@/generated/api/client.gen.js`)
 * when possible — its request interceptor at
 * `@/lib/api-interceptors.ts` already adds these headers automatically.
 * These helpers exist only for the cases that genuinely need raw `fetch`
 * (streaming SSE, blob downloads with manual progress, etc.).
 *
 * Anything that handles `Vellum-Organization-Id` or `X-CSRFToken` outside
 * `lib/auth/` and `lib/api-interceptors.ts` should be routed through here.
 * Drift between sites is the failure mode where a request that skips the
 * header is silently rejected upstream, the wrapper returns null, and the
 * UI degrades to a fallback instead of surfacing the error.
 *
 * **DO NOT add new helpers here.** Auth is moving to a single
 * gateway-issued session-cookie model where the SPA no longer
 * hand-attaches these headers — the central interceptor handles both
 * modes. This whole file is deleted once that lands.
 */
import { ensureCsrfCookie, getCsrfToken } from "@/lib/auth/csrf";
import { getSelfHostedActorToken } from "@/lib/self-hosted/connection";
import { isElectron } from "@/runtime/is-electron";
import { getElectronSessionToken } from "@/runtime/session-token";
import { getActiveOrganizationIdForRequests } from "@/stores/organization-store";

/**
 * Headers for a safe (GET/HEAD) request against an assistant-scoped
 * daemon route. Adds `Vellum-Organization-Id` when an active
 * organization is set.
 */
export function buildVellumHeaders(
  extra?: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = { ...(extra ?? {}) };
  const selfHostedToken = getSelfHostedActorToken();
  if (selfHostedToken) {
    headers["Authorization"] = `Bearer ${selfHostedToken}`;
    return headers;
  }
  const organizationId = getActiveOrganizationIdForRequests();
  if (organizationId) {
    headers["Vellum-Organization-Id"] = organizationId;
  }
  // Electron app provides a session token header. This is no-ops on web.
  const sessionToken = getElectronSessionToken();
  if (sessionToken) {
    headers["X-Session-Token"] = sessionToken;
  }
  return headers;
}

/**
 * Headers for a mutating (POST/PUT/PATCH/DELETE) request. Adds the org
 * header and, after bootstrapping the CSRF cookie, the `X-CSRFToken`
 * header that Django's `SessionAuthentication` requires.
 */
export async function buildVellumMutatingHeaders(
  extra?: Record<string, string>,
): Promise<Record<string, string>> {
  const headers = buildVellumHeaders(extra);
  if (headers["Authorization"]) return headers;
  // Electron authenticates via a token header - no CSRF needed.
  if (isElectron()) return headers;
  await ensureCsrfCookie();
  const csrfToken = getCsrfToken();
  if (csrfToken) {
    headers["X-CSRFToken"] = csrfToken;
  }
  return headers;
}
